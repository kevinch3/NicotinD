import { join } from 'node:path';
import { createLogger } from '@nicotind/core';
import type { Lidarr, LidarrRootFolder } from '../lidarr/index.js';

const log = createLogger('lidarr-root');

/**
 * Where Lidarr files the artists NicotinD adds (#1580). Lidarr is a metadata
 * source here — it never downloads or imports — yet an artist must live under a
 * root folder, and Lidarr rescans and import-evaluates every root daily. Pointing
 * that at the music library made it match ~20k files against ~1M catalogue
 * tracks until it ran out of memory. An empty root makes those scans free.
 *
 * Inside `/config` because linuxserver's init chowns `/config` to the Lidarr user
 * on every start, so the folder exists and passes Lidarr's writable check without
 * a manual step. → docs/deployment.md "Lidarr is a metadata source"
 */
export const LIDARR_METADATA_ROOT_DEFAULT = '/config/nicotind-metadata';

const METADATA_ROOT_NAME = 'NicotinD metadata';

/** Artists per editor request: Lidarr validates and rewrites each one in a single call. */
const REASSIGN_CHUNK = 100;

export interface LidarrRootPolicy {
  /** The root NicotinD files artists under, as Lidarr's container sees it. */
  metadataRoot: string;
  /** The library; no root may overlap it. */
  musicDir?: string;
}

export function resolveLidarrMetadataRoot(opts: {
  mode: 'embedded' | 'external';
  dataDir: string;
  rootFolder?: string;
}): string {
  if (opts.rootFolder) return opts.rootFolder;
  // Embedded Lidarr runs on our own filesystem, where `/config` means nothing.
  return opts.mode === 'embedded'
    ? join(opts.dataDir, 'lidarr-metadata')
    : LIDARR_METADATA_ROOT_DEFAULT;
}

/** The policy for a loaded config — dirs already `~`-expanded by the caller. */
export function lidarrRootPolicyFor(
  config: { mode: 'embedded' | 'external'; lidarr?: { rootFolder?: string } },
  dirs: { dataDir: string; musicDir: string },
): LidarrRootPolicy {
  return {
    metadataRoot: resolveLidarrMetadataRoot({
      mode: config.mode,
      dataDir: dirs.dataDir,
      rootFolder: config.lidarr?.rootFolder,
    }),
    musicDir: dirs.musicDir,
  };
}

/**
 * Boot-time root provisioning: register the metadata root, then warn — once per
 * boot, naming the fix — if a root still overlaps the library. Never throws:
 * Lidarr may simply not be up yet.
 */
export async function provisionLidarrRootAtBoot(
  lidarr: Lidarr,
  policy: LidarrRootPolicy,
): Promise<void> {
  try {
    const { overlapping } = await ensureArtistRootFolder(lidarr, policy);
    if (overlapping.length > 0) {
      log.warn(
        { roots: overlapping.map((r) => r.path), musicDir: policy.musicDir },
        'A Lidarr root folder overlaps the music library, so Lidarr rescans it daily (#1580). ' +
          'Run packages/api/src/scripts/lidarr-isolate-root.ts to move artists to the metadata root.',
      );
    }
  } catch (err) {
    log.warn(
      { err },
      'Lidarr root folder provisioning failed — discography may not work until Lidarr is reachable',
    );
  }
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** Equal, or one contains the other — a shared name prefix is not containment. */
export function pathsOverlap(a: string, b: string): boolean {
  const x = trimSlash(a);
  const y = trimSlash(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

function overlapsLibrary(path: string, policy: LidarrRootPolicy): boolean {
  return !!policy.musicDir && pathsOverlap(path, policy.musicDir);
}

/** The metadata root if registered, else any root kept apart from the library, else null. */
export function pickArtistRootFolder(
  roots: LidarrRootFolder[],
  policy: LidarrRootPolicy,
): string | null {
  const meta = roots.find((r) => trimSlash(r.path) === trimSlash(policy.metadataRoot));
  if (meta) return meta.path;
  return roots.find((r) => !overlapsLibrary(r.path, policy))?.path ?? null;
}

export interface EnsuredRootFolder {
  /** The root to add artists under. */
  path: string;
  /** Registered roots that overlap the library — each one is rescanned daily. */
  overlapping: LidarrRootFolder[];
}

/**
 * The root to add an artist under, registering the metadata root when needed.
 * Never registers the music library. When the metadata root cannot be registered
 * (an older compose without its volume) an existing overlapping root is used with
 * a warning, so adds keep working until the operator mounts it; with no root at
 * all the add fails with the fix in the message.
 */
export async function ensureArtistRootFolder(
  lidarr: Lidarr,
  policy: LidarrRootPolicy,
): Promise<EnsuredRootFolder> {
  const roots = await lidarr.artist.getRootFolders();
  const overlapping = roots.filter((r) => overlapsLibrary(r.path, policy));
  const picked = pickArtistRootFolder(roots, policy);
  if (picked) return { path: picked, overlapping };

  try {
    const added = await lidarr.artist.addRootFolder(policy.metadataRoot, METADATA_ROOT_NAME);
    log.info({ path: policy.metadataRoot }, 'Registered the Lidarr metadata root folder');
    return { path: added.path ?? policy.metadataRoot, overlapping };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const fallback = roots[0];
    if (fallback) {
      log.warn(
        { metadataRoot: policy.metadataRoot, fallback: fallback.path, reason },
        'Could not register the Lidarr metadata root — adding under a root that overlaps the music library (#1580)',
      );
      return { path: fallback.path, overlapping };
    }
    throw new Error(
      `Lidarr has no usable root folder: registering "${policy.metadataRoot}" failed (${reason}). ` +
        'Mount an empty, writable folder there in the Lidarr container (docs/deployment.md).',
    );
  }
}

export interface RootIsolationReport {
  metadataRoot: string;
  overlappingRoots: string[];
  /** Artists under an overlapping root before the run. */
  artistsToMove: number;
  moved: number;
  /** Artists still under an overlapping root after the run (re-read, not assumed). */
  remaining: number;
  removedRoots: string[];
  applied: boolean;
}

/**
 * Move every artist off roots that overlap the library onto the metadata root,
 * then unregister those roots — the one-time migration for a Lidarr provisioned
 * before #1580. Bookkeeping only: Lidarr's editor with `moveFiles: false` rewrites
 * stored paths and moves nothing on disk. A root is unregistered only once a
 * re-read shows no artist left under it. Dry run unless `apply`.
 */
export async function isolateLidarrRoot(
  lidarr: Lidarr,
  policy: LidarrRootPolicy,
  opts: { apply: boolean },
): Promise<RootIsolationReport> {
  const roots = await lidarr.artist.getRootFolders();
  const overlapping = roots.filter((r) => overlapsLibrary(r.path, policy));
  const underOverlap = (path: string | undefined) =>
    !!path && overlapping.some((r) => pathsOverlap(path, r.path));
  const toMove = (await lidarr.artist.list()).filter((a) => underOverlap(a.path));

  const report: RootIsolationReport = {
    metadataRoot: policy.metadataRoot,
    overlappingRoots: overlapping.map((r) => r.path),
    artistsToMove: toMove.length,
    moved: 0,
    remaining: toMove.length,
    removedRoots: [],
    applied: opts.apply,
  };
  if (!opts.apply || overlapping.length === 0) return report;

  if (!roots.some((r) => trimSlash(r.path) === trimSlash(policy.metadataRoot))) {
    // A failure here aborts before anything moves: there is nowhere to move to.
    try {
      await lidarr.artist.addRootFolder(policy.metadataRoot, METADATA_ROOT_NAME);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot register "${policy.metadataRoot}" (${reason}). Mount an empty, writable folder there in the Lidarr container first.`,
      );
    }
  }

  const ids = toMove.map((a) => a.id);
  for (let i = 0; i < ids.length; i += REASSIGN_CHUNK) {
    const chunk = ids.slice(i, i + REASSIGN_CHUNK);
    await lidarr.artist.reassignRootFolder(chunk, policy.metadataRoot);
    report.moved += chunk.length;
  }

  const after = await lidarr.artist.list();
  for (const r of overlapping) {
    const left = after.filter((a) => !!a.path && pathsOverlap(a.path, r.path)).length;
    if (left > 0) continue;
    await lidarr.artist.deleteRootFolder(r.id);
    report.removedRoots.push(r.path);
  }
  report.remaining = after.filter((a) => underOverlap(a.path)).length;
  return report;
}

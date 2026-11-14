#!/usr/bin/env bun
/**
 * Third-party licence manifest for Settings → About (#453, docs/licensing.md).
 *
 * Walks the production dependency closure of every workspace that ships, plus
 * a curated list of what npm cannot see (the image's system binaries and the
 * Python analysis sidecar), and writes SPDX ids with links, not licence texts
 * (owner decision, 2026-11-09). Runs at release only, from `.versionrc.json`'s
 * `postchangelog`, so no build or test ever rewrites the tracked file.
 *
 *   bun run scripts/generate-licenses.ts
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { BUILD_TOOLING } from './prune-build-tooling.js';

export type Surface = 'web' | 'server' | 'app' | 'image' | 'analysis';

export interface LicenceEntry {
  name: string;
  version: string;
  /** An SPDX id or expression; `UNKNOWN` when the package declares none. */
  license: string;
  url: string;
  surfaces: Surface[];
}

export interface Manifest {
  packages: LicenceEntry[];
}

/** Workspaces whose production dependencies ship, and what they ship as. */
export const SHIPPING_ROOTS: ReadonlyArray<{ dir: string; surface: Surface }> = [
  { dir: '.', surface: 'server' },
  { dir: 'packages/web', surface: 'web' },
  { dir: 'packages/mobile', surface: 'app' },
];

/** What ships without a package.json: the image's binaries and the sidecar. */
export const NON_NPM: readonly LicenceEntry[] = [
  {
    name: 'Bun',
    version: 'runtime',
    license: 'MIT',
    url: 'https://github.com/oven-sh/bun',
    surfaces: ['server'],
  },
  {
    name: 'FFmpeg',
    version: 'Debian',
    license: 'GPL-2.0-or-later',
    url: 'https://ffmpeg.org/legal.html',
    surfaces: ['image'],
  },
  {
    name: 'Chromaprint (fpcalc)',
    version: 'Debian',
    license: 'LGPL-2.1-or-later',
    url: 'https://github.com/acoustid/chromaprint',
    surfaces: ['image'],
  },
  {
    name: 'opus-tools',
    version: 'Debian',
    license: 'BSD-2-Clause',
    url: 'https://github.com/xiph/opus-tools',
    surfaces: ['image'],
  },
  {
    name: 'FastAPI',
    version: 'pip',
    license: 'MIT',
    url: 'https://github.com/fastapi/fastapi',
    surfaces: ['analysis'],
  },
  {
    name: 'Uvicorn',
    version: 'pip',
    license: 'BSD-3-Clause',
    url: 'https://github.com/encode/uvicorn',
    surfaces: ['analysis'],
  },
  {
    name: 'Essentia',
    version: 'pip',
    license: 'AGPL-3.0-only',
    url: 'https://github.com/MTG/essentia',
    surfaces: ['analysis'],
  },
  {
    name: 'TensorFlow',
    version: 'pip',
    license: 'Apache-2.0',
    url: 'https://github.com/tensorflow/tensorflow',
    surfaces: ['analysis'],
  },
  {
    name: 'NumPy',
    version: 'pip',
    license: 'BSD-3-Clause',
    url: 'https://github.com/numpy/numpy',
    surfaces: ['analysis'],
  },
];

interface PackageJson {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
  repository?: unknown;
  homepage?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** The SPDX expression a package.json declares, in any of its historical shapes. */
export function normalizeLicense(pkg: Pick<PackageJson, 'license' | 'licenses'>): string {
  const one = (v: unknown): string | null =>
    typeof v === 'string' && v.trim()
      ? v.trim()
      : v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string'
        ? (v as { type: string }).type.trim()
        : null;
  const direct = one(pkg.license);
  if (direct) return direct;
  if (Array.isArray(pkg.licenses)) {
    const ids = pkg.licenses.map(one).filter((x): x is string => !!x);
    if (ids.length === 1) return ids[0]!;
    if (ids.length > 1) return `(${ids.join(' OR ')})`;
  }
  return 'UNKNOWN';
}

/** A browsable https link for the package: its repository, homepage, or npm page. */
export function packageUrl(pkg: Pick<PackageJson, 'name' | 'repository' | 'homepage'>): string {
  const raw =
    typeof pkg.repository === 'string'
      ? pkg.repository
      : pkg.repository && typeof (pkg.repository as { url?: unknown }).url === 'string'
        ? (pkg.repository as { url: string }).url
        : null;
  if (raw) {
    const short = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(raw);
    if (short) return `https://github.com/${short[1]}`;
    const url = raw
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/^ssh:\/\/git@/, 'https://')
      .replace(/^git@([^:]+):/, 'https://$1/')
      .replace(/\.git$/, '');
    if (url.startsWith('https://')) return url;
  }
  if (typeof pkg.homepage === 'string' && pkg.homepage.startsWith('http')) return pkg.homepage;
  return `https://www.npmjs.com/package/${pkg.name}`;
}

/** Node resolution from a package's real directory: its own, then each parent's node_modules. */
function resolveDep(fromDir: string, name: string, stopAt: string): string | null {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return dirname(realpathSync(candidate));
    if (dir === stopAt || dir === dirname(dir)) return null;
    dir = dirname(dir);
  }
}

/**
 * The production closure of `roots`. Workspace packages (`@nicotind/*`) are
 * walked through but not listed: they are this repository, under its licence.
 * An optional dependency that is not installed (another platform's binary) is
 * skipped; a required one that is missing throws, because a manifest that
 * silently drops a package states something false. `pruned` names what the
 * production install deletes before it ships (#1810), so it is not walked.
 */
export function collect(
  repoRoot: string,
  roots = SHIPPING_ROOTS,
  pruned: readonly string[] = BUILD_TOOLING,
): LicenceEntry[] {
  const found = new Map<string, LicenceEntry>();
  const visited = new Set<string>();
  const read = (dir: string) =>
    JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;

  const walk = (dir: string, surface: Surface): void => {
    const key = `${dir}\0${surface}`;
    if (visited.has(key)) return;
    visited.add(key);
    const pkg = read(dir);
    const name = pkg.name ?? dir;
    if (!name.startsWith('@nicotind/') && dir !== repoRoot) {
      const id = `${name}@${pkg.version}`;
      const entry = found.get(id);
      if (entry) {
        if (!entry.surfaces.includes(surface)) entry.surfaces.push(surface);
      } else {
        found.set(id, {
          name,
          version: pkg.version ?? '',
          license: normalizeLicense(pkg),
          url: packageUrl(pkg),
          surfaces: [surface],
        });
      }
    }
    const deps: Array<[string, boolean]> = [
      ...Object.keys(pkg.dependencies ?? {}).map((d): [string, boolean] => [d, false]),
      ...Object.keys(pkg.optionalDependencies ?? {}).map((d): [string, boolean] => [d, true]),
    ];
    for (const [dep, optional] of deps) {
      if (pruned.includes(dep)) continue;
      const at = resolveDep(dir, dep, repoRoot);
      if (!at) {
        if (optional) continue;
        throw new Error(`${name} depends on ${dep}, which is not installed`);
      }
      walk(at, surface);
    }
  };

  for (const { dir, surface } of roots) walk(resolve(repoRoot, dir), surface);
  return [...found.values()];
}

/** Sorted and stable, so a release that changes no dependency changes no byte. */
export function buildManifest(
  npm: LicenceEntry[],
  extra: readonly LicenceEntry[] = NON_NPM,
): Manifest {
  const order: Surface[] = ['web', 'server', 'app', 'image', 'analysis'];
  const packages = [...npm, ...extra].map((e) => ({
    ...e,
    surfaces: [...e.surfaces].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
  }));
  packages.sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'),
  );
  return { packages };
}

export const MANIFEST_PATH = 'packages/web/public/licenses.json';

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, '..');
  const out = join(repoRoot, MANIFEST_PATH);
  writeFileSync(out, `${JSON.stringify(buildManifest(collect(repoRoot)), null, 2)}\n`);
  console.log(`wrote ${MANIFEST_PATH}`);
}

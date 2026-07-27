/**
 * Bulk-fill artist portraits — the one-shot counterpart to the windowed
 * `artist-image` enrichment task and the per-artist on-demand route
 * (issue #250). Resolves each portrait-less artist through the same
 * priority-ordered provider chain (`lidarr → spotify → …`) and writes
 * `library_artwork (kind='artist')`.
 *
 *   bun run packages/api/src/scripts/backfill-artist-images.ts           # dry run
 *   bun run packages/api/src/scripts/backfill-artist-images.ts --apply   # write
 *   bun run packages/api/src/scripts/backfill-artist-images.ts --apply --limit 50
 *
 * WHY a script when the task exists: the task runs **only inside the daily
 * processing window** and is **default-off** in the `gates` set, so a fresh
 * library can sit placeholder-only indefinitely with no in-app way to fix it in
 * bulk. Every other enrichment column already has a backfill script
 * (`backfill-licence.ts`, `analyze-bpm.ts`, `append-genre-backfill.ts`); this
 * closes the gap for portraits.
 *
 * Resolution logic is NOT reimplemented here — it calls the shared
 * `fillArtistImages`, so the script, the route and the task cannot drift.
 * Artists with `manual_override = 1` are excluded by the shared SQL predicate,
 * so a curator's pick is never overwritten.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_CONFIG, plus whatever the providers need
 * (NICOTIND_LIDARR_URL / LIDARR_API_KEY for the Lidarr provider).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { Lidarr } from '@nicotind/lidarr-client';
import {
  countArtistsNeedingPortrait,
  fillArtistImages,
  selectArtistsNeedingPortrait,
} from '../services/artist-image-fill.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

function loadConfig(): { dataDir: string; lidarrUrl: string | null; lidarrKey: string | null } {
  let fileConfig: Record<string, unknown> = {};
  const configPath = resolve(process.env.NICOTIND_CONFIG ?? 'config/default.yml');
  try {
    fileConfig = (parse(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
  } catch {
    /* no config file */
  }
  const dataDir = expandHome(
    process.env.NICOTIND_DATA_DIR ?? (fileConfig.dataDir as string | undefined) ?? '~/.nicotind',
  );
  const lidarr = (fileConfig.lidarr ?? {}) as { url?: string; apiKey?: string };
  return {
    dataDir,
    lidarrUrl: process.env.NICOTIND_LIDARR_URL ?? lidarr.url ?? null,
    lidarrKey: process.env.LIDARR_API_KEY ?? lidarr.apiKey ?? null,
  };
}

/** `--limit N`, defaulting to every pending artist. */
export function parseLimit(argv: string[], fallback: number): number {
  const i = argv.indexOf('--limit');
  if (i === -1) return fallback;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--limit expects a positive number (got "${argv[i + 1]}")`);
  }
  return Math.floor(n);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const { dataDir, lidarrUrl, lidarrKey } = loadConfig();

  const dbPath = join(dataDir, 'nicotind.db');
  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath} (set NICOTIND_DATA_DIR).`);
    process.exit(1);
  }
  const db = new Database(dbPath);

  const pending = countArtistsNeedingPortrait(db);
  const limit = parseLimit(argv, pending);
  const rows = selectArtistsNeedingPortrait(db, limit);

  console.log(`${pending} artist(s) without a portrait; processing ${rows.length}.`);
  if (!apply) {
    for (const a of rows.slice(0, 20)) console.log(`  · ${a.name}`);
    if (rows.length > 20) console.log(`  … and ${rows.length - 20} more`);
    console.log('\nDry run — pass --apply to resolve and write.');
    return;
  }

  const lidarr =
    lidarrUrl && lidarrKey ? new Lidarr({ baseUrl: lidarrUrl, apiKey: lidarrKey }) : null;
  if (!lidarr) console.log('Lidarr not configured — using the remaining providers only.');

  const { applied, labels, unresolved } = await fillArtistImages(
    db,
    // The spotify provider needs the running plugin registry, which a CLI has
    // no access to; the chain simply skips an unconfigured source. Run the
    // windowed task (or the per-artist route) for Spotify coverage.
    { lidarr, spotifyLookup: null, coverCacheDir: join(dataDir, 'cover-cache') },
    rows,
  );

  for (const l of labels) console.log(`  ✓ ${l}`);
  console.log(`\nFilled ${applied} of ${rows.length}.`);
  if (unresolved.length) {
    console.log(`No provider had a portrait for ${unresolved.length}:`);
    for (const n of unresolved.slice(0, 20)) console.log(`  · ${n}`);
    if (unresolved.length > 20) console.log(`  … and ${unresolved.length - 20} more`);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

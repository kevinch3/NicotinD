/**
 * Backfill canonical artwork (Lidarr cover/poster URLs) for albums & artists
 * already in the library, so the app shows the same images the hunt tool does
 * and artists get real poster thumbnails.
 *
 *   bun run packages/api/src/scripts/backfill-artwork.ts                   # dry run
 *   bun run packages/api/src/scripts/backfill-artwork.ts --apply           # write
 *   bun run packages/api/src/scripts/backfill-artwork.ts --apply --album-lookup
 *   bun run packages/api/src/scripts/backfill-artwork.ts --apply --lookup-missing
 *
 * Matches artists monitored in Lidarr (via artist_discography_links / name) and
 * their albums (edition-stripped group key). `--album-lookup` adds a targeted
 * per-album MusicBrainz lookup for substantial albums (default >3 tracks, override
 * with `--min-tracks N`) still missing art — independent of monitored status, and
 * skips Singles/Various-Artists junk. `--lookup-missing` instead does a slow
 * per-artist lookup for every non-monitored artist (off by default — pathological
 * on a large library). Idempotent. Env: NICOTIND_DATA_DIR, NICOTIND_CONFIG, LIDARR_URL or
 * NICOTIND_LIDARR_URL, LIDARR_API_KEY (falls back to config.lidarr.url and
 * dataDir/secrets.json). With the stack's own env set, runs in-container as:
 *   docker compose exec nicotind bun run packages/api/src/scripts/backfill-artwork.ts --apply
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { Lidarr } from '@nicotind/lidarr-client';
import { backfillArtwork } from '../services/artwork-backfill.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

function loadConfig(): { dataDir: string; lidarrUrl: string; lidarrApiKey: string } {
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
  const lidarrCfg = (fileConfig.lidarr as { url?: string } | undefined) ?? {};
  // NICOTIND_LIDARR_URL is the canonical env the running stack sets (resolves to
  // http://lidarr:8686 inside Docker), so the script Just Works in-container.
  const lidarrUrl =
    process.env.LIDARR_URL ??
    process.env.NICOTIND_LIDARR_URL ??
    lidarrCfg.url ??
    'http://localhost:8686';

  let lidarrApiKey = process.env.LIDARR_API_KEY ?? '';
  if (!lidarrApiKey) {
    const secretsPath = join(dataDir, 'secrets.json');
    if (existsSync(secretsPath)) {
      try {
        lidarrApiKey = JSON.parse(readFileSync(secretsPath, 'utf-8')).lidarrApiKey ?? '';
      } catch {
        /* ignore */
      }
    }
  }
  return { dataDir, lidarrUrl, lidarrApiKey };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const lookupMissing = process.argv.includes('--lookup-missing');
  const albumLookup = process.argv.includes('--album-lookup');
  const minTracksArg = process.argv.indexOf('--min-tracks');
  const minTracks = minTracksArg !== -1 ? Number(process.argv[minTracksArg + 1]) : 4;
  // >3 tracks ⇒ minimum of 4. Only used when --album-lookup is set.
  const albumLookupMinTracks = albumLookup
    ? Number.isFinite(minTracks)
      ? minTracks
      : 4
    : undefined;
  const { dataDir, lidarrUrl, lidarrApiKey } = loadConfig();
  const dbPath = join(dataDir, 'nicotind.db');

  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(1);
  }
  if (!lidarrApiKey) {
    console.error('Lidarr API key not found. Set LIDARR_API_KEY or run nicotind once.');
    process.exit(1);
  }

  const db = new Database(dbPath, { readwrite: true });
  db.run('PRAGMA busy_timeout = 5000');
  const lidarr = new Lidarr({ baseUrl: lidarrUrl, apiKey: lidarrApiKey });

  console.log(`Mode      : ${apply ? 'APPLY (writing)' : 'DRY RUN (no changes)'}`);
  console.log(`Lidarr    : ${lidarrUrl}`);
  console.log(`Database  : ${dbPath}`);
  const mode = lookupMissing
    ? 'monitored + per-artist MusicBrainz lookup'
    : albumLookupMinTracks != null
      ? `monitored + per-album lookup (>=${albumLookupMinTracks} tracks)`
      : 'monitored only';
  console.log(`Lookup    : ${mode}\n`);

  const r = await backfillArtwork(db, lidarr, {
    apply,
    lookupMissing,
    albumLookupMinTracks,
    coverCacheDir: join(dataDir, 'cover-cache'),
  });

  console.log(
    `\nDone (${apply ? 'applied' : 'dry run'}). ` +
      `artists matched=${r.artistsMatched} unresolved=${r.artistsUnresolved}; ` +
      `albums matched=${r.albumsMatched} unresolved=${r.albumsUnresolved}` +
      (albumLookupMinTracks != null
        ? `; album-lookup attempted=${r.albumsLookedUp} matched=${r.albumLookupMatched}`
        : ''),
  );
  if (!apply && (r.artistsMatched > 0 || r.albumsMatched > 0)) {
    console.log('\nRe-run with --apply to write this artwork.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

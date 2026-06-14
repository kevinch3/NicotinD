/**
 * Optimize album metadata (cover art, year, release type) for the existing
 * library by re-fetching from Lidarr/MusicBrainz and **overwriting** what's
 * stored — the bulk counterpart to the per-album "Optimize metadata" button.
 * Unlike backfill-artwork (which only fills missing art), this replaces a
 * wrong/poor cover on a confident match.
 *
 *   bun run packages/api/src/scripts/optimize-metadata.ts            # dry run (missing/poor only)
 *   bun run packages/api/src/scripts/optimize-metadata.ts --apply    # write
 *   bun run packages/api/src/scripts/optimize-metadata.ts --apply --all   # re-verify every album
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_CONFIG, LIDARR_URL or NICOTIND_LIDARR_URL,
 * LIDARR_API_KEY (falls back to config.lidarr.url and dataDir/secrets.json).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { Lidarr } from '@nicotind/lidarr-client';
import { optimizeAllAlbums } from '../services/metadata-optimize.js';

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
  const onlyMissingOrPoor = !process.argv.includes('--all');
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
  console.log(`Scope     : ${onlyMissingOrPoor ? 'albums missing artwork/year' : 'all albums'}\n`);

  const r = await optimizeAllAlbums(db, lidarr, {
    apply,
    onlyMissingOrPoor,
    coverCacheDir: join(dataDir, 'cover-cache'),
  });

  console.log(
    `\nDone (${apply ? 'applied' : 'dry run'}). albums=${r.albums} matched=${r.matched} ` +
      `covers=${r.coversUpdated} years=${r.yearsUpdated} releaseTypes=${r.releaseTypesUpdated}`,
  );
  if (!apply && r.matched > 0) {
    console.log('\nRe-run with --apply to write these updates.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

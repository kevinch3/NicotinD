/**
 * Seed the artist-split authority (`library_artist_identity`) for every compound
 * artist string already in the library, using Lidarr/MusicBrainz — the one-shot
 * counterpart to the windowed `artist-identity` enrichment task.
 *
 * Why: the scanner splits a compound like "Bob Marley, Peter Tosh" into individual
 * artists only when it can *confirm* the parts. Confirmation comes from atomic
 * library names (free, offline) plus this cached Lidarr/MB authority. Running this
 * before a full rescan means the first rescan already has the Lidarr decisions,
 * rather than waiting for the background task to drain over several nightly windows.
 *
 *   bun run packages/api/src/scripts/resolve-artist-identity.ts            # dry run
 *   bun run packages/api/src/scripts/resolve-artist-identity.ts --apply    # write authority
 *   ... --limit 100                                                        # process a slice
 *
 * Env: NICOTIND_DATA_DIR, LIDARR_URL/NICOTIND_LIDARR_URL, LIDARR_API_KEY
 *      (falls back to config.lidarr.url + dataDir/secrets.json).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { Lidarr } from '@nicotind/lidarr-client';
import { splitOnDelimiters } from '../services/artist-split.js';
import { artistIdFor } from '../services/library-scanner.js';
import { upsertArtistIdentity } from '../services/artist-identity-store.js';
import {
  makeLidarrArtistIdentityResolver,
  pendingArtistIdentityRows,
  ARTIST_IDENTITY_TTL_MS,
} from '../services/enrichment/tasks.js';

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
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : undefined;
  const { dataDir, lidarrUrl, lidarrApiKey } = loadConfig();
  const dbPath = join(dataDir, 'nicotind.db');

  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(2);
  }
  if (!lidarrApiKey) {
    console.error('Lidarr API key not found. Set LIDARR_API_KEY or run nicotind once with Lidarr.');
    process.exit(2);
  }

  const db = apply
    ? new Database(dbPath, { readwrite: true })
    : new Database(dbPath, { readonly: true });
  if (apply) db.run('PRAGMA busy_timeout = 5000');
  const resolve_ = makeLidarrArtistIdentityResolver(
    new Lidarr({ baseUrl: lidarrUrl, apiKey: lidarrApiKey }),
  );

  // Resolve everything unresolved (cutoff = now - TTL). Dry run inspects only.
  const names = pendingArtistIdentityRows(db, Date.now() - ARTIST_IDENTITY_TTL_MS, limit);
  console.log(`Mode      : ${apply ? 'APPLY (writing)' : 'DRY RUN (no changes)'}`);
  console.log(`Lidarr    : ${lidarrUrl}`);
  console.log(`Database  : ${dbPath}`);
  console.log(`Compounds : ${names.length}\n`);

  const counts = { single: 0, split: 0, unknown: 0 };
  for (const name of names) {
    const parts = splitOnDelimiters(name);
    const { decision, members } = await resolve_(name, parts);
    counts[decision]++;
    const suffix =
      decision === 'split'
        ? ` → ${members.join(' + ')}`
        : decision === 'single'
          ? ' (one act)'
          : '';
    console.log(`  [${decision}] ${name}${suffix}`);
    if (apply) {
      upsertArtistIdentity(db, {
        artistKey: artistIdFor(name),
        rawName: name,
        decision,
        members,
        source: 'lidarr',
      });
    }
  }

  console.log(`\nsingle=${counts.single}  split=${counts.split}  unknown=${counts.unknown}`);
  if (!apply) console.log('Dry run — re-run with --apply to write, then trigger a full rescan.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

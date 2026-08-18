/**
 * Bulk-fill artist origin countries (docs/artist-origin.md) — the one-shot
 * counterpart to the windowed `artist-origin` enrichment task, so an existing
 * library fills in one run instead of trickling through daily windows.
 *
 *   bun run packages/api/src/scripts/backfill-artist-origins.ts           # dry run
 *   bun run packages/api/src/scripts/backfill-artist-origins.ts --apply   # write
 *
 * Resolution logic is NOT reimplemented here — it drives the shared
 * `artistOriginTask.run`, so the script and the task cannot drift. Lidarr, when
 * configured, provides the MBID fallback for artists `library_mbids` doesn't
 * know yet (same as the windowed task).
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_CONFIG, NICOTIND_LIDARR_URL / LIDARR_API_KEY.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { Lidarr } from '@nicotind/lidarr-client';
import { expandHome } from '@nicotind/core';
import {
  getTask,
  makeArtistOriginLookup,
  type EnrichmentContext,
} from '../services/enrichment/tasks.js';

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

  const task = getTask('artist-origin')!;
  const pending = task.countPending(db);
  console.log(`${pending} artist(s) pending origin.`);
  if (!apply) {
    console.log('Dry run — pass --apply to resolve and write.');
    return;
  }

  const lidarr =
    lidarrUrl && lidarrKey ? new Lidarr({ baseUrl: lidarrUrl, apiKey: lidarrKey }) : null;
  if (!lidarr) console.log('Lidarr not configured — MBID fallback disabled for uncached artists.');

  // The task only reads lookupArtistOrigin + lidarr from its context; the rest
  // of EnrichmentContext is song-analysis machinery a CLI has no business
  // constructing, so a narrow cast is the honest shape here.
  const ctx = { lookupArtistOrigin: makeArtistOriginLookup(dataDir), lidarr } as EnrichmentContext;

  let total = 0;
  for (;;) {
    const r = await task.run(db, ctx, 50);
    total += r.applied;
    for (const l of r.labels) console.log(`  ✓ ${l}`);
    const left = task.countPending(db);
    console.log(`applied ${r.applied} (total ${total}); ${left} still pending`);
    if (left === 0) break;
    if (r.applied === 0 && r.failed === 0) {
      console.log('Remaining artists tombstoned (no MBID / no MB country) — done for now.');
      break;
    }
    if (r.applied === 0 && r.failed > 0) {
      console.error(`Stopping: repeated failures (${r.errorSample ?? 'unknown error'}).`);
      break;
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

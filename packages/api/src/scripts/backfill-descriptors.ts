/**
 * Bulk-fill `library_song_descriptors` (timbre / groove / spectral balance)
 * for the whole library — the bulk counterpart to the windowed `descriptors`
 * enrichment task. Requires the analysis sidecar (packages/analysis) to be
 * running with its /descriptors endpoint available (no model files needed).
 *
 *   NICOTIND_ANALYSIS_URL=http://localhost:8000 \
 *   bun run packages/api/src/scripts/backfill-descriptors.ts            # dry run
 *   … --apply                                                          # write
 *   … --apply --limit 50 --concurrency 2
 *
 * Runs the SAME task body the scheduler runs (`getTask('descriptors').run`),
 * so the pending predicate, the #258 size guard and the failure ledger can't
 * drift between the two entry points — the backfill-artist-origins.ts shape.
 * Selection is "no usable current-version row", so a re-run resumes; a
 * `DESCRIPTOR_VERSION` bump re-selects every song.
 *
 * Env: NICOTIND_ANALYSIS_URL (required), NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR,
 *      NICOTIND_CONFIG.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { expandHome } from '@nicotind/core';
import { AudioFeaturesClient } from '../services/audio-features-client.js';
import { descriptorsPendingClause } from '../services/descriptor-store.js';
import { createEnrichmentContext, getTask } from '../services/enrichment/tasks.js';

function loadConfig(): { dataDir: string; musicDir: string; analysisUrl: string } {
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
  const musicDirRaw = process.env.NICOTIND_MUSIC_DIR ?? (fileConfig.musicDir as string | undefined);
  if (!musicDirRaw) throw new Error('musicDir not configured');
  const analysisUrl =
    process.env.NICOTIND_ANALYSIS_URL ??
    ((fileConfig.analysis as Record<string, unknown> | undefined)?.url as string | undefined) ??
    '';
  return { dataDir, musicDir: expandHome(musicDirRaw), analysisUrl };
}

function numFlag(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const limit = numFlag('--limit', 0);
  const concurrency = numFlag('--concurrency', 2);
  const batch = 25;

  const { dataDir, musicDir, analysisUrl } = loadConfig();
  if (!analysisUrl) {
    console.error('NICOTIND_ANALYSIS_URL not configured — the sidecar is required. Aborting.');
    process.exit(2);
  }
  const client = new AudioFeaturesClient({ baseUrl: analysisUrl });
  await client.healthy();
  if (!client.descriptorsSnapshot()) {
    console.error(
      `Analysis sidecar at ${analysisUrl} is unreachable or has no /descriptors endpoint. Aborting.`,
    );
    process.exit(2);
  }

  const dbPath = join(dataDir, 'nicotind.db');
  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(2);
  }
  const db = apply
    ? new Database(dbPath, { readwrite: true })
    : new Database(dbPath, { readonly: true });
  if (apply) db.run('PRAGMA busy_timeout = 5000');

  const pending =
    db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM library_songs s WHERE ${descriptorsPendingClause('s')}`,
      )
      .get()?.n ?? 0;

  console.log(`Mode        : ${apply ? 'APPLY (writing)' : 'DRY RUN (no changes)'}`);
  console.log(`Music dir   : ${musicDir}`);
  console.log(`Database    : ${dbPath}`);
  console.log(`Sidecar     : ${analysisUrl}`);
  console.log(`Concurrency : ${concurrency}`);
  console.log(`Songs w/o descriptors: ${pending}${limit > 0 ? ` (limited to ${limit})` : ''}\n`);

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to analyse and store descriptors.\n');
    return;
  }

  const task = getTask('descriptors')!;
  const ctx = createEnrichmentContext({
    musicDir,
    coverCacheDir: join(dataDir, 'cover-cache'),
    lidarr: null,
    concurrency,
    audioFeaturesClient: client,
    dataDir,
  });
  const available = task.available(ctx);
  if (available !== true) {
    console.error(`descriptors task unavailable: ${available}`);
    process.exit(2);
  }

  const target = limit > 0 ? Math.min(limit, pending) : pending;
  let applied = 0;
  let failed = 0;
  let errorSample: string | null = null;
  const started = Date.now();
  while (applied + failed < target) {
    const res = await task.run(db, ctx, Math.min(batch, target - applied - failed));
    applied += res.applied;
    failed += res.failed;
    errorSample = res.errorSample ?? errorSample;
    if (res.applied === 0 && res.failed === 0) {
      // Nothing moved: the sidecar is down (songs stay pending) or only
      // ledger-excluded files remain. Either way, re-running later resumes.
      console.error('\nNo progress in the last batch — stopping. Re-run to resume.');
      break;
    }
    const elapsed = (Date.now() - started) / 1000;
    console.log(
      `  …${applied + failed}/${target} (${applied} stored, ${failed} failed, ${(elapsed / Math.max(1, applied + failed)).toFixed(1)} s/track)`,
    );
  }

  console.log(`\n✅ Done: ${applied} stored, ${failed} failed.`);
  if (errorSample) console.log(`  last error: ${errorSample}`);
}

if (import.meta.main) {
  await main();
}

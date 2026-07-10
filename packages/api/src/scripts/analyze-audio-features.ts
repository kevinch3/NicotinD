/**
 * Batch-fill missing audio features (danceability/valence/acousticness/
 * instrumentalness/mood + cached embedding) for the whole library — the bulk
 * counterpart to the windowed `audio-features` enrichment task. Requires the
 * analysis sidecar (packages/analysis) to be running and healthy.
 *
 *   NICOTIND_ANALYSIS_URL=http://localhost:8000 \
 *   bun run packages/api/src/scripts/analyze-audio-features.ts            # dry run
 *   … --apply                                                            # write
 *   … --apply --limit 50 --concurrency 2
 *
 * Tag-first: a file already carrying all five feature tags is adopted without
 * a sidecar call. On --apply results are written to the DB (feature columns +
 * library_embeddings) **and** back into the file tags so they survive a
 * rescan. Selection is `danceability IS NULL`, so a re-run resumes.
 *
 * Env: NICOTIND_ANALYSIS_URL (required), NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR,
 *      NICOTIND_CONFIG.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { AudioFeaturesClient, AudioFileRejectedError } from '../services/audio-features-client.js';
import { readAudioTags, writeAudioTags } from '../services/audio-tags.js';
import { resolveSongAbsPath } from '../services/track-backfill.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

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

interface SongRow {
  id: string;
  path: string;
  artist: string;
  title: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const limit = numFlag('--limit', 0);
  const concurrency = numFlag('--concurrency', 2);

  const { dataDir, musicDir, analysisUrl } = loadConfig();
  if (!analysisUrl) {
    console.error('NICOTIND_ANALYSIS_URL not configured — the sidecar is required. Aborting.');
    process.exit(2);
  }
  const client = new AudioFeaturesClient({ baseUrl: analysisUrl });
  if (!(await client.healthy())) {
    console.error(`Analysis sidecar at ${analysisUrl} is unreachable or has no models. Aborting.`);
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

  let sql =
    'SELECT id, path, artist, title FROM library_songs WHERE danceability IS NULL ORDER BY created DESC';
  if (limit > 0) sql += ` LIMIT ${limit}`;
  const rows = db.query<SongRow, []>(sql).all();

  console.log(`Mode        : ${apply ? 'APPLY (writing)' : 'DRY RUN (no changes)'}`);
  console.log(`Music dir   : ${musicDir}`);
  console.log(`Database    : ${dbPath}`);
  console.log(`Sidecar     : ${analysisUrl}`);
  console.log(`Concurrency : ${concurrency}`);
  console.log(`Songs w/o features: ${rows.length}${limit > 0 ? ` (limited to ${limit})` : ''}\n`);

  const logPath = join(dataDir, 'analyze-audio-features.log');
  let fromTag = 0;
  let analyzed = 0;
  let missing = 0;
  let failed = 0;
  let processed = 0;
  const samples: string[] = [];

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const idx = cursor++;
      if (idx >= rows.length) return;
      const song = rows[idx]!;
      const abs = resolveSongAbsPath(musicDir, song.path);
      const label = `${song.artist} — ${song.title}`;
      if (!existsSync(abs)) {
        missing++;
        continue;
      }

      // Tag-first: adopt a fully-tagged file without re-analysis.
      let tags;
      try {
        tags = await readAudioTags(abs);
      } catch {
        tags = {};
      }
      const fullyTagged =
        tags.danceability !== undefined &&
        tags.valence !== undefined &&
        tags.acousticness !== undefined &&
        tags.instrumental !== undefined &&
        tags.mood !== undefined;

      if (fullyTagged) {
        fromTag++;
        if (samples.length < 25) samples.push(`  • ${label}  →  ${tags.mood}  (tags)`);
        if (apply) {
          db.run(
            `UPDATE library_songs SET danceability = ?, valence = ?, acousticness = ?, instrumental = ?, mood = ? WHERE id = ?`,
            [tags.danceability!, tags.valence!, tags.acousticness!, tags.instrumental!, tags.mood!, song.id],
          );
          appendFileSync(logPath, `${new Date().toISOString()}\ttag\t${tags.mood}\t${label}\n`);
        }
        processed++;
        continue;
      }

      let result;
      try {
        result = await client.analyze(song.path);
      } catch (err) {
        // 422 = the file is genuinely un-decodable (corrupt/too short) — count
        // it and move on; don't let one bad file abort the whole bulk run.
        failed++;
        if (samples.length < 25 && err instanceof AudioFileRejectedError) {
          samples.push(`  • ${label}  →  REJECTED (${err.message})`);
        }
        continue;
      }
      if (!result) {
        failed++;
        if (!(await client.healthy())) {
          console.error('\nSidecar became unavailable mid-run — stopping. Re-run to resume.');
          cursor = rows.length; // stop all workers
        }
        continue;
      }
      analyzed++;
      const f = result.features;
      if (samples.length < 25) samples.push(`  • ${label}  →  ${f.mood}  (analyzed)`);
      if (apply) {
        db.run(
          `UPDATE library_songs SET danceability = ?, valence = ?, acousticness = ?, instrumental = ?, mood = ? WHERE id = ?`,
          [f.danceability, f.valence, f.acousticness, f.instrumental, f.mood, song.id],
        );
        db.run(
          `INSERT OR REPLACE INTO library_embeddings (song_id, model, dim, vec, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [
            song.id,
            result.embedding.model,
            result.embedding.dim,
            Buffer.from(new Float32Array(result.embedding.values).buffer),
            Date.now(),
          ],
        );
        await writeAudioTags(abs, {
          danceability: f.danceability,
          valence: f.valence,
          acousticness: f.acousticness,
          instrumental: f.instrumental,
          mood: f.mood,
        }).catch(() => false);
        appendFileSync(logPath, `${new Date().toISOString()}\tanalyzed\t${f.mood}\t${label}\n`);
      }
      processed++;
      if (processed % 50 === 0) console.log(`  …${processed} processed`);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

  console.log(`\n${apply ? 'Applied' : 'Would fill'} features for ${fromTag + analyzed} songs:`);
  console.log(`  ${String(fromTag).padStart(5)}  from existing file tags`);
  console.log(`  ${String(analyzed).padStart(5)}  freshly analyzed`);
  if (missing) console.log(`  ${String(missing).padStart(5)}  skipped (file missing on disk)`);
  if (failed) console.log(`  ${String(failed).padStart(5)}  analysis failed`);
  if (samples.length) {
    console.log('\nSample:');
    for (const s of samples) console.log(s);
  }
  if (!apply) {
    console.log(
      '\nDry run only. Re-run with --apply to write features to the DB and file tags.\n',
    );
  } else {
    console.log(`\n✅ Done. Log: ${logPath}\n`);
  }
}

if (import.meta.main) {
  await main();
}

/**
 * Batch-fill missing energy + loudness for the whole library — the bulk
 * counterpart to the windowed `energy` enrichment task. Offline: needs only
 * ffmpeg (`ebur128` filter), no sidecar or Lidarr.
 *
 *   bun run packages/api/src/scripts/analyze-energy.ts                  # dry run
 *   bun run packages/api/src/scripts/analyze-energy.ts --apply          # write
 *   bun run packages/api/src/scripts/analyze-energy.ts --apply --limit 50
 *   bun run packages/api/src/scripts/analyze-energy.ts --apply --concurrency 4
 *
 * For each song with no energy: prefer an ENERGY value already on the file tag,
 * else run a full-file EBU R128 measurement (`analyzeLoudness`). On --apply the
 * result is written to `library_songs.energy`/`loudness` **and** back into the
 * file tag so it survives a rescan. Selection is `energy IS NULL`, so a re-run
 * resumes where the last one stopped.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { analyzeLoudness } from '../services/loudness-analysis.js';
import { readAudioTags, writeAudioTags } from '../services/audio-tags.js';
import { ffmpegAvailable } from '../services/transcode.js';
import { resolveSongAbsPath } from '../services/track-backfill.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

function loadConfig(): { dataDir: string; musicDir: string } {
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
  return { dataDir, musicDir: expandHome(musicDirRaw) };
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
  const concurrency = numFlag('--concurrency', 3);

  if (!ffmpegAvailable()) {
    console.error('ffmpeg not found on PATH — loudness analysis requires ffmpeg. Aborting.');
    process.exit(2);
  }

  const { dataDir, musicDir } = loadConfig();
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
    'SELECT id, path, artist, title FROM library_songs WHERE energy IS NULL ORDER BY created DESC';
  if (limit > 0) sql += ` LIMIT ${limit}`;
  const rows = db.query<SongRow, []>(sql).all();

  console.log(`Mode        : ${apply ? 'APPLY (writing)' : 'DRY RUN (no changes)'}`);
  console.log(`Music dir   : ${musicDir}`);
  console.log(`Database    : ${dbPath}`);
  console.log(`Concurrency : ${concurrency}`);
  console.log(`Songs w/o energy: ${rows.length}${limit > 0 ? ` (limited to ${limit})` : ''}\n`);

  const logPath = join(dataDir, 'analyze-energy.log');
  let fromTag = 0;
  let analyzed = 0;
  let missing = 0;
  let failed = 0;
  let processed = 0;
  const samples: string[] = [];

  // Bounded worker pool: each analyzeLoudness decodes the whole file, so cap
  // the number running at once. Workers pull off a shared cursor.
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
      let energy: number | null = null;
      let loudness: number | null = null;
      let source: 'tag' | 'analyzed' = 'tag';
      try {
        const tags = await readAudioTags(abs);
        if (tags.energy !== undefined) {
          energy = tags.energy;
          loudness = tags.loudness ?? null;
        } else {
          source = 'analyzed';
          const result = await analyzeLoudness(abs);
          if (result) {
            energy = result.energy;
            loudness = result.loudness;
          }
        }
      } catch {
        energy = null;
      }
      if (energy === null) {
        failed++;
        continue;
      }
      if (source === 'tag') fromTag++;
      else analyzed++;
      if (samples.length < 25)
        samples.push(`  • ${label}  →  energy ${energy.toFixed(2)}  (${source})`);
      if (apply) {
        db.run('UPDATE library_songs SET energy = ?, loudness = ? WHERE id = ?', [
          energy,
          loudness,
          song.id,
        ]);
        if (source === 'analyzed')
          await writeAudioTags(abs, { energy, loudness: loudness ?? undefined }).catch(
            () => false,
          );
        appendFileSync(
          logPath,
          `${new Date().toISOString()}\t${source}\t${energy}\t${loudness}\t${label}\n`,
        );
      }
      processed++;
      if (processed % 50 === 0) console.log(`  …${processed} processed`);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

  console.log(`\n${apply ? 'Applied' : 'Would fill'} energy for ${fromTag + analyzed} songs:`);
  console.log(`  ${String(fromTag).padStart(5)}  from existing file tag`);
  console.log(`  ${String(analyzed).padStart(5)}  freshly analyzed`);
  if (missing) console.log(`  ${String(missing).padStart(5)}  skipped (file missing on disk)`);
  if (failed) console.log(`  ${String(failed).padStart(5)}  could not measure loudness`);
  if (samples.length) {
    console.log('\nSample:');
    for (const s of samples) console.log(s);
  }
  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write energy to the DB and file tags.\n');
  } else {
    console.log(`\n✅ Done. Log: ${logPath}\n`);
  }
}

if (import.meta.main) {
  await main();
}

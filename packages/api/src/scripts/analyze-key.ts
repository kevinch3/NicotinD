/**
 * Batch-fill missing musical key for the whole library — the bulk counterpart to
 * the windowed key task and the per-track analyze. Offline: needs only ffmpeg
 * (no Lidarr), like analyze-bpm.ts.
 *
 *   bun run packages/api/src/scripts/analyze-key.ts                  # dry run
 *   bun run packages/api/src/scripts/analyze-key.ts --apply          # write
 *   bun run packages/api/src/scripts/analyze-key.ts --apply --limit 50
 *   bun run packages/api/src/scripts/analyze-key.ts --apply --concurrency 4
 *
 * For each song with no key: prefer a key already on the file tag, else decode a
 * slice and estimate the key (Krumhansl–Schmuckler, see key-detection.ts). On
 * --apply the result is written to `library_songs.key` AND back into the file tag
 * (`writeAudioTags`) so it survives a rescan. Selection is `key IS NULL` and
 * writes are incremental, so a re-run resumes where the last one stopped.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { analyzeKey } from '../services/track-analysis.js';
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
    console.error('ffmpeg not found on PATH — key analysis requires ffmpeg. Aborting.');
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
    "SELECT id, path, artist, title FROM library_songs WHERE key IS NULL OR key = '' ORDER BY created DESC";
  if (limit > 0) sql += ` LIMIT ${limit}`;
  const rows = db.query<SongRow, []>(sql).all();

  console.log(`Mode        : ${apply ? 'APPLY (writing)' : 'DRY RUN (no changes)'}`);
  console.log(`Music dir   : ${musicDir}`);
  console.log(`Database    : ${dbPath}`);
  console.log(`Concurrency : ${concurrency}`);
  console.log(`Songs w/o key: ${rows.length}${limit > 0 ? ` (limited to ${limit})` : ''}\n`);

  const logPath = join(dataDir, 'analyze-key.log');
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
      let key: string | null = null;
      let source: 'tag' | 'analyzed' = 'tag';
      try {
        const tags = await readAudioTags(abs);
        key = tags.key ?? null;
        if (!key) {
          source = 'analyzed';
          key = await analyzeKey(abs);
        }
      } catch {
        key = null;
      }
      if (!key) {
        failed++;
        continue;
      }
      if (source === 'tag') fromTag++;
      else analyzed++;
      if (samples.length < 25) samples.push(`  • ${label}  →  ${key}  (${source})`);
      if (apply) {
        db.run('UPDATE library_songs SET key = ? WHERE id = ?', [key, song.id]);
        if (source === 'analyzed') await writeAudioTags(abs, { key }).catch(() => false);
        appendFileSync(logPath, `${new Date().toISOString()}\t${source}\t${key}\t${label}\n`);
      }
      processed++;
      if (processed % 50 === 0) console.log(`  …${processed} processed`);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

  console.log(`\n${apply ? 'Applied' : 'Would fill'} key for ${fromTag + analyzed} songs:`);
  console.log(`  ${String(fromTag).padStart(5)}  from existing file tag`);
  console.log(`  ${String(analyzed).padStart(5)}  freshly analyzed`);
  if (missing) console.log(`  ${String(missing).padStart(5)}  skipped (file missing on disk)`);
  if (failed) console.log(`  ${String(failed).padStart(5)}  could not determine key`);
  if (samples.length) {
    console.log('\nSample:');
    for (const s of samples) console.log(s);
  }
  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write key to the DB and file tags.\n');
  } else {
    console.log(`\n✅ Done. Log: ${logPath}\n`);
  }
}

if (import.meta.main) {
  await main();
}

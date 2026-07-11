/**
 * Batch BPM analysis for the whole library — the bulk counterpart to the
 * per-track "Analyze" button (POST /api/library/songs/:id/analyze).
 *
 * Two modes:
 *
 *  **Fill (default)** — songs with no BPM: prefer a BPM already on the file
 *  tag, else detect one (sidecar first when configured, local music-tempo
 *  fallback) and write DB + tag.
 *
 *  **Recheck (--recheck)** — ALL songs: re-detect via the analysis sidecar's
 *  Essentia RhythmExtractor2013 (required for this mode) and overwrite a
 *  stored BPM that confidently disagrees. Exists because music-tempo makes
 *  frequent octave (half/double-tempo) errors — a library sample showed ~50%
 *  of stored BPMs off by 2x — and those wrong values were also written into
 *  the file tags, so this mode deliberately ignores tags. Overwrite policy is
 *  `shouldUpdateBpm` (confidence floor + ±2 BPM agreement tolerance).
 *
 *   bun run packages/api/src/scripts/analyze-bpm.ts                    # fill, dry run
 *   bun run packages/api/src/scripts/analyze-bpm.ts --apply            # fill, write
 *   bun run packages/api/src/scripts/analyze-bpm.ts --recheck          # recheck, dry run
 *   bun run packages/api/src/scripts/analyze-bpm.ts --recheck --apply  # recheck, write
 *   ... --limit 50 --concurrency 4 --min-conf 1.5
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG,
 *      NICOTIND_ANALYSIS_URL (sidecar base URL; required for --recheck).
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { analyzeBpm } from '../services/track-analysis.js';
import { AudioFeaturesClient } from '../services/audio-features-client.js';
import { readAudioTags, writeAudioTags } from '../services/audio-tags.js';
import { ffmpegAvailable } from '../services/transcode.js';
import { resolveSongAbsPath, shouldUpdateBpm } from '../services/track-backfill.js';

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
  bpm: number | null;
}

/** Library-relative path for the sidecar (which resolves against its own mount). */
function songRelPath(musicDir: string, songPath: string): string {
  const normalized = songPath.replace(/\\/g, '/');
  return isAbsolute(normalized) ? relative(musicDir, normalized) : normalized;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const recheck = process.argv.includes('--recheck');
  const limit = numFlag('--limit', 0);
  const concurrency = numFlag('--concurrency', recheck ? 2 : 3);
  // Essentia's multifeature confidence is 0–5.32; <1.5 is a poor lock. Below
  // the floor an existing stored value is kept (fills of NULL still happen).
  const minConf = numFlag('--min-conf', 1.5);

  const analysisUrl = process.env.NICOTIND_ANALYSIS_URL ?? '';
  const sidecar = analysisUrl ? new AudioFeaturesClient({ baseUrl: analysisUrl }) : null;

  if (recheck && !sidecar) {
    console.error('--recheck requires NICOTIND_ANALYSIS_URL (Essentia sidecar). Aborting.');
    process.exit(2);
  }
  if (!recheck && !sidecar && !ffmpegAvailable()) {
    console.error('ffmpeg not found on PATH — BPM analysis requires ffmpeg. Aborting.');
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

  let sql = `SELECT id, path, artist, title, bpm FROM library_songs${
    recheck ? '' : ' WHERE bpm IS NULL'
  } ORDER BY created DESC`;
  if (limit > 0) sql += ` LIMIT ${limit}`;
  const rows = db.query<SongRow, []>(sql).all();

  console.log(`Mode        : ${recheck ? 'RECHECK (all songs)' : 'FILL (missing BPM)'}`);
  console.log(`Write       : ${apply ? 'APPLY (writing)' : 'DRY RUN (no changes)'}`);
  console.log(`Music dir   : ${musicDir}`);
  console.log(`Database    : ${dbPath}`);
  console.log(`Detector    : ${sidecar ? `sidecar ${analysisUrl}` : 'local music-tempo'}`);
  if (recheck) console.log(`Min conf    : ${minConf}`);
  console.log(`Concurrency : ${concurrency}`);
  console.log(`Songs       : ${rows.length}${limit > 0 ? ` (limited to ${limit})` : ''}\n`);

  const logPath = join(dataDir, recheck ? 'analyze-bpm-recheck.log' : 'analyze-bpm.log');
  let fromTag = 0;
  let analyzed = 0;
  let unchanged = 0;
  let lowConf = 0;
  let missing = 0;
  let failed = 0;
  let processed = 0;
  const samples: string[] = [];

  // Bounded worker pool. Fill mode decodes ~90 s of ffmpeg per track; recheck
  // mode calls the sidecar, which serializes analysis internally — more than
  // 2 in flight only queues there.
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

      let bpm: number | null = null;
      let source: 'tag' | 'analyzed' = 'analyzed';
      try {
        if (recheck) {
          // Tags are deliberately ignored: the old detector wrote its octave
          // errors into them, so they can't vouch for the stored value.
          const r = await sidecar!.rhythm(songRelPath(musicDir, song.path)).catch(() => null);
          if (!r) {
            failed++;
            continue;
          }
          if (!shouldUpdateBpm(song.bpm, r.bpm, r.confidence, minConf)) {
            if (song.bpm !== null && Math.abs(Math.round(r.bpm) - song.bpm) > 2) lowConf++;
            else unchanged++;
            continue;
          }
          bpm = Math.round(r.bpm);
          if (samples.length < 40) {
            samples.push(
              `  • ${label}  ${song.bpm ?? '—'} → ${bpm} BPM  (conf ${r.confidence.toFixed(2)})`,
            );
          }
        } else {
          const tags = await readAudioTags(abs);
          bpm = tags.bpm ?? null;
          if (bpm) {
            source = 'tag';
          } else if (sidecar) {
            const r = await sidecar.rhythm(songRelPath(musicDir, song.path)).catch(() => null);
            if (r) bpm = Math.round(r.bpm);
          }
          if (!bpm) bpm = await analyzeBpm(abs);
          if (bpm && samples.length < 40) samples.push(`  • ${label}  →  ${bpm} BPM  (${source})`);
        }
      } catch {
        bpm = null;
      }
      if (!bpm) {
        failed++;
        continue;
      }
      if (source === 'tag') fromTag++;
      else analyzed++;
      if (apply) {
        db.run('UPDATE library_songs SET bpm = ? WHERE id = ?', [bpm, song.id]);
        if (source === 'analyzed') await writeAudioTags(abs, { bpm }).catch(() => false);
        appendFileSync(
          logPath,
          `${new Date().toISOString()}\t${source}\t${song.bpm ?? '-'}\t${bpm}\t${label}\n`,
        );
      }
      processed++;
      if (processed % 50 === 0) console.log(`  …${processed} processed`);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

  console.log(`\n${apply ? 'Applied' : 'Would write'} BPM for ${fromTag + analyzed} songs:`);
  console.log(`  ${String(fromTag).padStart(5)}  from existing file tag`);
  console.log(`  ${String(analyzed).padStart(5)}  freshly analyzed`);
  if (recheck) {
    console.log(`  ${String(unchanged).padStart(5)}  agreed with stored value (kept)`);
    console.log(`  ${String(lowConf).padStart(5)}  disagreed but low confidence (kept)`);
  }
  if (missing) console.log(`  ${String(missing).padStart(5)}  skipped (file missing on disk)`);
  if (failed) console.log(`  ${String(failed).padStart(5)}  could not determine BPM`);
  if (samples.length) {
    console.log('\nSample:');
    for (const s of samples) console.log(s);
  }
  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write BPM to the DB and file tags.\n');
  } else {
    console.log(`\n✅ Done. Log: ${logPath}\n`);
  }
}

if (import.meta.main) {
  await main();
}

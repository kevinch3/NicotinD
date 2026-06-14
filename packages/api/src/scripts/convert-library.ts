/**
 * Convert the existing library's lossless files (FLAC/WAV/…) to Opus in place,
 * mirroring the post-download standardization. Already-lossy files are left
 * untouched. Reclaims storage and gives the web player a uniform codec.
 *
 *   bun run packages/api/src/scripts/convert-library.ts             # dry run
 *   bun run packages/api/src/scripts/convert-library.ts --apply     # write
 *   bun run packages/api/src/scripts/convert-library.ts --apply --bitrate 96
 *
 * Per-file it migrates song-keyed references (playlist entries, acquisitions,
 * starred/hidden) across the id change. Env: NICOTIND_DATA_DIR,
 * NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { transcodeLibraryToOpus } from '../services/library-transcode.js';

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

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const bitrateIdx = process.argv.indexOf('--bitrate');
  const bitRate = bitrateIdx >= 0 ? Number(process.argv[bitrateIdx + 1]) : 128;
  const { dataDir, musicDir } = loadConfig();
  const dbPath = join(dataDir, 'nicotind.db');

  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readwrite: true });
  db.run('PRAGMA busy_timeout = 5000');

  console.log(`Mode      : ${apply ? 'APPLY (writing)' : 'DRY RUN (no changes)'}`);
  console.log(`Music dir : ${musicDir}`);
  console.log(`Bitrate   : ${bitRate}k`);
  console.log(`Database  : ${dbPath}\n`);

  const r = await transcodeLibraryToOpus(db, musicDir, { apply, bitRate });

  const mb = (r.bytesReclaimed / (1024 * 1024)).toFixed(1);
  console.log(
    `\nDone (${apply ? 'applied' : 'dry run'}). candidates=${r.candidates} converted=${r.converted} ` +
      `skipped=${r.skipped} failed=${r.failed} reclaimed≈${mb}MB`,
  );
  if (!apply && r.converted > 0) {
    console.log('\nRe-run with --apply to transcode these files.');
  }
}

if (import.meta.main) {
  await main();
}

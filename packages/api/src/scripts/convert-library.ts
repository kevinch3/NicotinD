/**
 * Convert the existing library's lossless files (FLAC/WAV/…) to Opus in place,
 * mirroring the post-download standardization. Already-lossy files are left
 * untouched. Reclaims storage and gives the web player a uniform codec.
 *
 *   bun run packages/api/src/scripts/convert-library.ts             # dry run
 *   bun run packages/api/src/scripts/convert-library.ts --apply     # write
 *   bun run packages/api/src/scripts/convert-library.ts --apply
 *   bun run packages/api/src/scripts/convert-library.ts --apply --bitrate 96   # pin one rate
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
import { resolveTranscodeLossless } from '../services/transcode-settings.js';
import { expandHome } from '@nicotind/core';

function loadConfig(): { dataDir: string; musicDir: string; bitRate: number } {
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
  return {
    dataDir,
    musicDir: expandHome(musicDirRaw),
    bitRate: resolveTranscodeLossless(fileConfig).bitRate,
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  // Opt OUT of keeping the originals, never opt in. This script computed
  // `dataDir` for the DB path and then did not pass it, so every run deleted
  // the files it replaced while the quarantine it was meant to use sat unused.
  const deleteOriginals = process.argv.includes('--delete-originals');
  const bitrateIdx = process.argv.indexOf('--bitrate');
  const { dataDir, musicDir, bitRate: configuredBitRate } = loadConfig();
  // `--bitrate` pins one rate for every file. Without it the pass reads each
  // file's own through the ladder, which is what the library wants: its mp3
  // bitrates are bimodal, so a single number is wrong for most of them either
  // way. `configuredBitRate` is only the label printed below.
  const bitRate = bitrateIdx >= 0 ? Number(process.argv[bitrateIdx + 1]) : undefined;
  const dbPath = join(dataDir, 'nicotind.db');

  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readwrite: true });
  db.run('PRAGMA busy_timeout = 5000');

  console.log(`Mode      : ${apply ? 'APPLY (writing)' : 'DRY RUN (no changes)'}`);
  console.log(`Music dir : ${musicDir}`);
  console.log(
    `Bitrate   : ${bitRate ? `${bitRate}k (pinned)` : `adaptive, 64–128k by source (config: ${configuredBitRate}k)`}`,
  );
  console.log(`Database  : ${dbPath}`);
  console.log(
    `Originals : ${deleteOriginals ? 'DELETED after conversion' : `kept under ${join(dataDir, 'quarantine')}`}\n`,
  );

  const r = await transcodeLibraryToOpus(db, musicDir, {
    apply,
    bitRate,
    dataDir: deleteOriginals ? undefined : dataDir,
  });

  const mb = (r.bytesReclaimed / (1024 * 1024)).toFixed(1);
  console.log(
    `\nDone (${apply ? 'applied' : 'dry run'}). candidates=${r.candidates} converted=${r.converted} ` +
      `skipped=${r.skipped} failed=${r.failed} reclaimed${apply ? '=' : '≈'}${mb}MB`,
  );
  if (r.unestimated > 0) {
    // Say which number you mean: with unknown durations in the set, the figure
    // above is a floor, not an estimate.
    console.log(
      `  ${r.unestimated} candidate(s) had no duration, so no saving was estimated for them — ` +
        `reclaimed is a floor.`,
    );
  }
  if (r.quarantineRun) {
    console.log(`  Originals kept in ${r.quarantineRun} — delete it once you are satisfied.`);
  }
  if (!apply && r.converted > 0) {
    console.log('\nRe-run with --apply to transcode these files.');
  }
}

if (import.meta.main) {
  await main();
}

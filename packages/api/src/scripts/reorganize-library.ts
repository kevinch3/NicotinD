/**
 * One-shot library reorganization.
 *
 *   bun run packages/api/src/scripts/reorganize-library.ts                    # dry run
 *   bun run packages/api/src/scripts/reorganize-library.ts --limit 20         # preview 20
 *   bun run packages/api/src/scripts/reorganize-library.ts --apply --limit 20 # move 20
 *   bun run packages/api/src/scripts/reorganize-library.ts --apply            # move all
 *   bun run packages/api/src/scripts/reorganize-library.ts --apply --transcode
 *
 * Reads every audio file under <musicDir>, flattens phantom dirs, reads
 * tags, fingerprints unknowns (if AcoustID key is configured and fpcalc
 * is installed), then moves each file into:
 *
 *   <musicDir>/<Artist>/<Album>/<NN - Title>.<ext>
 *
 * Dry run by default: it reports the plan and touches nothing. `--apply` is
 * required to move a file, rewrite a tag, delete junk or prune a dir.
 *
 * `--transcode` additionally standardizes the lossless files it moves on Opus.
 * That step deletes the source and is NOT revertible from reorg-moves.log, so
 * unlike the rest of this script it never runs unasked. → docs/download-pipeline.md
 *
 * Every move is appended to <dataDir>/reorg-moves.log so a manual revert
 * is possible. Idempotent — re-running on a clean library is a no-op.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */

import { readFileSync, readdirSync, statSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, join, extname, dirname, basename, relative } from 'node:path';
import { parse } from 'yaml';
import { LibraryOrganizer, type PlacementPlan } from '../services/library-organizer.js';
import { ffmpegAvailable } from '../services/transcode.js';
import { downloadsDirFor, reservedDirsFor } from '../services/library-paths.js';
import {
  resolveTranscodeLossless,
  type ResolvedTranscodeLossless,
} from '../services/transcode-settings.js';
import { AcoustIdLookup } from '../services/acoustid-lookup.js';
import { AUDIO_EXTENSIONS, expandHome } from '@nicotind/core';

interface LoadedConfig {
  dataDir: string;
  musicDir: string;
  acoustidApiKey: string | undefined;
  transcodeLossless: ResolvedTranscodeLossless;
}

function loadConfig(): LoadedConfig {
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
  const musicDir = expandHome(musicDirRaw);

  let acoustidApiKey: string | undefined;
  try {
    const secrets = JSON.parse(readFileSync(join(dataDir, 'secrets.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    acoustidApiKey =
      typeof secrets.acoustidApiKey === 'string' ? secrets.acoustidApiKey : undefined;
  } catch {
    /* no secrets file */
  }

  return {
    dataDir,
    musicDir,
    acoustidApiKey,
    transcodeLossless: resolveTranscodeLossless(fileConfig),
  };
}

interface Args {
  apply: boolean;
  transcode: boolean;
  limit: number | undefined;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Args {
  const limitIdx = argv.indexOf('--limit');
  let limit: number | undefined;
  if (limitIdx >= 0) {
    limit = Number(argv[limitIdx + 1]);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new UsageError(
        `--limit needs a positive integer, got ${argv[limitIdx + 1] ?? '(nothing)'}`,
      );
    }
  }
  return { apply: argv.includes('--apply'), transcode: argv.includes('--transcode'), limit };
}

/** Recursively yield every audio file under `root`, skipping `excludeDirs` (absolute paths). */
function* walkAudioFiles(root: string, excludeDirs: Set<string>): Generator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (excludeDirs.has(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (excludeDirs.has(full)) continue;
        stack.push(full);
      } else if (st.isFile() && AUDIO_EXTENSIONS.has(extname(full).toLowerCase())) {
        yield full;
      }
    }
  }
}

/**
 * Remove directories left empty, bottom-up. When `apply` is false nothing is
 * unlinked — the walk instead counts the dirs that a real run would remove,
 * treating a would-be-removed child as already gone so the count cascades the
 * same way the removals would.
 */
function pruneEmptyDirs(root: string, apply: boolean): number {
  let removed = 0;
  /** True when `dir` is empty, or would be once its empty children go. */
  const walk = (dir: string): boolean => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }
    let remaining = 0;
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory() || !walk(full)) remaining++;
    }
    if (remaining > 0 || dir === root) return false;
    if (!apply) {
      removed++;
      return true;
    }
    try {
      rmdirSync(dir);
      removed++;
      return true;
    } catch {
      return false;
    }
  };
  walk(root);
  return removed;
}

/**
 * Delete .DS_Store / Thumbs.db / desktop.ini so they don't keep dirs alive
 * after we move the audio out.
 */
function cleanJunk(root: string, apply: boolean): number {
  const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
  let removed = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (JUNK.has(name)) {
        if (!apply) {
          removed++;
          continue;
        }
        try {
          unlinkSync(full);
          removed++;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return removed;
}

/** Human-readable byte size, matching convert-library's MB reporting at scale. */
function humanBytes(n: number): string {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)}GB` : `${(n / 1024 ** 2).toFixed(1)}MB`;
}

async function main(): Promise<void> {
  const { apply, transcode, limit } = parseArgs(process.argv);
  const { dataDir, musicDir, acoustidApiKey, transcodeLossless } = loadConfig();
  const moveLogPath = join(dataDir, 'reorg-moves.log');

  // The transcode deletes its source and reorg-moves.log cannot revert it, so
  // it is opt-in here even though the download path runs it from config (#840).
  const ffmpeg = ffmpegAvailable();
  const willTranscode = transcode && transcodeLossless.enabled && ffmpeg;
  const transcodeNote = !transcode
    ? 'off (pass --transcode to standardize lossless on Opus)'
    : !transcodeLossless.enabled
      ? 'requested, but downloads.transcodeLossless.enabled is false in config'
      : !ffmpeg
        ? 'requested, but ffmpeg is not on PATH — no file will be re-encoded'
        : `ON — lossless → Opus ${transcodeLossless.bitRate}k, IRREVERSIBLE (source deleted). ` +
          'Only files that actually move; use convert-library.ts for the rest';

  console.log(`Mode      : ${apply ? 'APPLY (writing)' : 'DRY RUN (no changes)'}`);
  console.log(`Data dir  : ${dataDir}`);
  console.log(`Music dir : ${musicDir}`);
  console.log(`AcoustID  : ${acoustidApiKey ? 'enabled' : 'disabled (no key in secrets.json)'}`);
  console.log(`Transcode : ${transcodeNote}`);
  console.log(`Limit     : ${limit ?? 'none (every file)'}`);
  console.log(`Move log  : ${moveLogPath}\n`);

  if (!existsSync(musicDir)) {
    console.error(`musicDir does not exist: ${musicDir}`);
    process.exit(1);
  }

  console.log('Pass 0: Clean junk files (.DS_Store, Thumbs.db, …)');
  const junk = cleanJunk(musicDir, apply);
  console.log(`  ${apply ? 'removed' : 'would remove'} ${junk} junk files\n`);

  const acoustid = acoustidApiKey ? new AcoustIdLookup(acoustidApiKey) : undefined;
  const unsortedDir = join(dataDir, 'unsorted');
  const organizer = new LibraryOrganizer({
    musicDir,
    acoustid,
    moveLogPath,
    // Reorganize is an ingest path like any other: a lossless file it moves is
    // standardized on Opus by the same hook the download path uses — but only
    // when asked, since that step is the one this script cannot undo.
    transcodeLossless: { enabled: willTranscode, bitRate: transcodeLossless.bitRate },
    // Park unsortable files OUTSIDE musicDir so Navidrome doesn't scan them.
    unsortedRoot: unsortedDir,
  });
  // Avoid looping over our own unsorted bucket if it happens to live under musicDir.
  // Staging is not library content: reorganize must not sweep in-flight
  // downloads into <Artist>/<Album>. → docs/library-path-conventions.md
  const excludeDirs = new Set<string>([unsortedDir, downloadsDirFor(musicDir)]);
  for (const name of reservedDirsFor()) excludeDirs.add(join(musicDir, name));

  console.log(`Pass 1+2+3: ${apply ? 'Organize' : 'Plan'} every audio file`);
  let processed = 0;
  let moved = 0;
  let skipped = 0;
  let unsorted = 0;
  let failed = 0;
  let wouldTranscode = 0;
  let losslessBytes = 0;
  const samples: PlacementPlan[] = [];
  const SAMPLE_LIMIT = 20;
  const startedAt = Date.now();

  // Snapshot the list before we start moving, otherwise renames invalidate the walk.
  const all: string[] = [];
  for (const f of walkAudioFiles(musicDir, excludeDirs)) all.push(f);
  const files = limit === undefined ? all : all.slice(0, limit);
  console.log(
    `  found ${all.length} audio files` +
      (files.length === all.length ? '\n' : `, taking the first ${files.length}\n`),
  );

  for (const filepath of files) {
    if (!existsSync(filepath)) {
      // Already moved as a side-effect of phantom-flatten on a sibling? Skip.
      continue;
    }
    const peerDir = basename(dirname(filepath));
    let outcome: 'moved' | 'skipped' | 'unsorted' | 'failed';
    if (apply) {
      outcome = await organizer.organizeFile(filepath, peerDir);
    } else {
      try {
        const plan = await organizer.planOrganizeFile(filepath, peerDir);
        outcome = plan.outcome;
        if (plan.wouldTranscode) {
          wouldTranscode++;
          try {
            losslessBytes += statSync(plan.srcPath).size;
          } catch {
            /* vanished mid-walk — the count still stands */
          }
        }
        if (plan.outcome !== 'skipped' && samples.length < SAMPLE_LIMIT) samples.push(plan);
      } catch (err) {
        console.warn(`  cannot plan ${filepath}: ${(err as Error).message}`);
        outcome = 'failed';
      }
    }
    processed++;
    if (outcome === 'moved') moved++;
    else if (outcome === 'skipped') skipped++;
    else if (outcome === 'unsorted') unsorted++;
    else failed++;

    if (processed % 100 === 0) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(
        `  [${processed}/${files.length}] moved=${moved} unsorted=${unsorted} skipped=${skipped} failed=${failed} (${elapsed}s)`,
      );
    }
  }

  const verb = apply ? 'Done' : 'Plan';
  console.log(
    `\n${verb}. moved=${moved} unsorted=${unsorted} skipped=${skipped} failed=${failed}\n`,
  );

  if (!apply) {
    if (wouldTranscode > 0) {
      // Upper bound, the same convention convert-library.ts reports: the Opus
      // output still occupies part of it.
      console.log(
        `  ${wouldTranscode} lossless file${wouldTranscode === 1 ? '' : 's'} would be re-encoded ` +
          `to Opus (${humanBytes(losslessBytes)} of source, IRREVERSIBLE)\n`,
      );
    }
    if (samples.length > 0) {
      console.log(`  Sample of what would move (${samples.length} of ${moved + unsorted}):`);
      for (const p of samples) {
        console.log(`    ${relative(musicDir, p.srcPath)}`);
        // The move target, not the final name: the transcode re-encodes to .opus
        // and deletes this file, so naming it would overstate what we know.
        const note = p.wouldTranscode ? '  [then re-encoded to .opus, source deleted]' : '';
        console.log(`      → ${relative(musicDir, p.destPath)}${note}`);
      }
      console.log('');
    }
  }

  console.log(`Pass 4: Prune empty directories`);
  const pruned = pruneEmptyDirs(musicDir, apply);
  console.log(
    `  ${apply ? 'removed' : 'would remove'} ${pruned} empty dirs` +
      (apply ? '\n' : ' (more will empty once the files move)\n'),
  );

  if (!apply) {
    console.log('Nothing was changed. Re-run with --apply to perform this plan.');
    console.log('Bound the first real run with --limit N and inspect the result.');
    return;
  }

  console.log('Pass 5: Triggering Navidrome rescan…');
  // We don't import the navidrome client here to keep the script lightweight.
  // The user should manually trigger a full rescan from the Navidrome UI, or
  // restart nicotind (its DownloadWatcher fires a scan on startup).
  console.log('  (Restart nicotind or hit Navidrome\'s "Scan Library" — full rescan needed)\n');

  console.log('Library reorganization complete.');
}

main().catch((err) => {
  // A mistyped flag is the user's typo, not a crash — don't bury it in a trace.
  if (err instanceof UsageError) {
    console.error(`${err.message}\n`);
    console.error('Usage: reorganize-library.ts [--apply] [--transcode] [--limit N]');
    process.exit(2);
  }
  console.error('Fatal:', err);
  process.exit(1);
});

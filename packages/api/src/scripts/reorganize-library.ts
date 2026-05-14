/**
 * One-shot library reorganization.
 *
 *   bun run packages/api/src/scripts/reorganize-library.ts
 *
 * Reads every audio file under <musicDir>, flattens phantom dirs, reads
 * tags, fingerprints unknowns (if AcoustID key is configured and fpcalc
 * is installed), then moves each file into:
 *
 *   <musicDir>/<Artist>/<Album>/<NN - Title>.<ext>
 *
 * Every move is appended to <dataDir>/reorg-moves.log so a manual revert
 * is possible. Idempotent — re-running on a clean library is a no-op.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */

import { readFileSync, readdirSync, statSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, join, extname, dirname, basename } from 'node:path';
import { parse } from 'yaml';
import { LibraryOrganizer } from '../services/library-organizer.js';
import { AcoustIdLookup } from '../services/acoustid-lookup.js';
import { AUDIO_EXTS } from '../services/audio-tags.js';

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

interface LoadedConfig {
  dataDir: string;
  musicDir: string;
  acoustidApiKey: string | undefined;
}

function loadConfig(): LoadedConfig {
  let fileConfig: Record<string, unknown> = {};
  const configPath = resolve(process.env.NICOTIND_CONFIG ?? 'config/default.yml');
  try {
    fileConfig = (parse(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
  } catch { /* no config file */ }

  const dataDir = expandHome(
    process.env.NICOTIND_DATA_DIR ?? (fileConfig.dataDir as string | undefined) ?? '~/.nicotind',
  );
  const musicDirRaw = process.env.NICOTIND_MUSIC_DIR ?? (fileConfig.musicDir as string | undefined);
  if (!musicDirRaw) throw new Error('musicDir not configured');
  const musicDir = expandHome(musicDirRaw);

  let acoustidApiKey: string | undefined;
  try {
    const secrets = JSON.parse(readFileSync(join(dataDir, 'secrets.json'), 'utf-8')) as Record<string, unknown>;
    acoustidApiKey = typeof secrets.acoustidApiKey === 'string' ? secrets.acoustidApiKey : undefined;
  } catch { /* no secrets file */ }

  return { dataDir, musicDir, acoustidApiKey };
}

/** Recursively yield every audio file under `root`, skipping `excludeDirs` (absolute paths). */
function* walkAudioFiles(root: string, excludeDirs: Set<string>): Generator<string> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (excludeDirs.has(dir)) continue;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (excludeDirs.has(full)) continue;
        stack.push(full);
      } else if (st.isFile() && AUDIO_EXTS.has(extname(full).toLowerCase())) {
        yield full;
      }
    }
  }
}

function pruneEmptyDirs(root: string): number {
  let removed = 0;
  const walk = (dir: string): boolean => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return false; }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
    }
    let remaining: string[];
    try { remaining = readdirSync(dir); } catch { return false; }
    if (remaining.length === 0 && dir !== root) {
      try { rmdirSync(dir); removed++; return true; } catch { return false; }
    }
    return false;
  };
  walk(root);
  return removed;
}

/**
 * Delete .DS_Store / Thumbs.db / desktop.ini so they don't keep dirs alive
 * after we move the audio out.
 */
function cleanJunk(root: string): number {
  const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
  let removed = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) stack.push(full);
      else if (JUNK.has(name)) {
        try { unlinkSync(full); removed++; } catch { /* ignore */ }
      }
    }
  }
  return removed;
}

async function main(): Promise<void> {
  const { dataDir, musicDir, acoustidApiKey } = loadConfig();
  const moveLogPath = join(dataDir, 'reorg-moves.log');

  console.log(`Data dir : ${dataDir}`);
  console.log(`Music dir: ${musicDir}`);
  console.log(`AcoustID : ${acoustidApiKey ? 'enabled' : 'disabled (no key in secrets.json)'}`);
  console.log(`Move log : ${moveLogPath}\n`);

  if (!existsSync(musicDir)) {
    console.error(`musicDir does not exist: ${musicDir}`);
    process.exit(1);
  }

  console.log('Pass 0: Clean junk files (.DS_Store, Thumbs.db, …)');
  const junk = cleanJunk(musicDir);
  console.log(`  removed ${junk} junk files\n`);

  const acoustid = acoustidApiKey ? new AcoustIdLookup(acoustidApiKey) : undefined;
  const unsortedDir = join(dataDir, 'unsorted');
  const organizer = new LibraryOrganizer({
    musicDir,
    acoustid,
    moveLogPath,
    // Park unsortable files OUTSIDE musicDir so Navidrome doesn't scan them.
    unsortedRoot: unsortedDir,
  });
  // Avoid looping over our own unsorted bucket if it happens to live under musicDir.
  const excludeDirs = new Set<string>([unsortedDir]);

  console.log('Pass 1+2+3: Organize every audio file');
  let processed = 0;
  let moved = 0;
  let skipped = 0;
  let unsorted = 0;
  let failed = 0;
  const startedAt = Date.now();

  // Snapshot the list before we start moving, otherwise renames invalidate the walk.
  const files: string[] = [];
  for (const f of walkAudioFiles(musicDir, excludeDirs)) files.push(f);
  console.log(`  found ${files.length} audio files\n`);

  for (const filepath of files) {
    if (!existsSync(filepath)) {
      // Already moved as a side-effect of phantom-flatten on a sibling? Skip.
      continue;
    }
    const peerDir = basename(dirname(filepath));
    const outcome = await organizer.organizeFile(filepath, peerDir);
    processed++;
    if (outcome === 'moved') moved++;
    else if (outcome === 'skipped') skipped++;
    else if (outcome === 'unsorted') unsorted++;
    else failed++;

    if (processed % 100 === 0) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(`  [${processed}/${files.length}] moved=${moved} unsorted=${unsorted} skipped=${skipped} failed=${failed} (${elapsed}s)`);
    }
  }

  console.log(`\nDone. moved=${moved} unsorted=${unsorted} skipped=${skipped} failed=${failed}\n`);

  console.log('Pass 4: Prune empty directories');
  const pruned = pruneEmptyDirs(musicDir);
  console.log(`  removed ${pruned} empty dirs\n`);

  console.log('Pass 5: Triggering Navidrome rescan…');
  // We don't import the navidrome client here to keep the script lightweight.
  // The user should manually trigger a full rescan from the Navidrome UI, or
  // restart nicotind (its DownloadWatcher fires a scan on startup).
  console.log('  (Restart nicotind or hit Navidrome\'s "Scan Library" — full rescan needed)\n');

  console.log('Library reorganization complete.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

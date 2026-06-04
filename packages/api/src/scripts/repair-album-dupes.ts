/**
 * Repair album folders bloated with redundant per-track duplicate rips.
 *
 *   bun run packages/api/src/scripts/repair-album-dupes.ts            # dry run
 *   bun run packages/api/src/scripts/repair-album-dupes.ts --apply    # delete
 *
 * Background:
 *   Before the cross-peer-fallback fix (target the chosen folder's manifest, not
 *   the canonical Lidarr tracklist), the album-hunt fallback could dump several
 *   near-complete rips of the same album into one <Artist>/<Album> folder —
 *   `02 - Circus.mp3`, `02 - Circus (2).mp3`, `(3)`, FLAC/MP3 and case/punctuation
 *   variants. Navidrome then split the bloated folder by embedded mbz_album_id
 *   into several duplicate album cards.
 *
 * How it works:
 *   1. Walks every <musicDir>/<Artist>/<Album>/ directory (skips Singles/ — those
 *      legitimately hold many distinct tracks and are owned by repair-singles).
 *   2. Groups audio files by a normalized track identity (`dupKey`) that strips
 *      the leading track number, a trailing " (N)" collision suffix, the
 *      extension, and punctuation/case. Distinct qualifiers like "(live)" /
 *      "(acoustic version)" stay in the key, so only TRUE copies are grouped.
 *   3. For each group with >1 file, keeps the best one (`pickKeeper`: FLAC first,
 *      then larger size, then the un-suffixed name) and deletes the rest.
 *   4. Best-effort removes the deleted files' completed_downloads rows.
 *
 * Safe by default: dry-run unless --apply is passed. Every deletion is appended
 * to <dataDir>/repair-album-dupes.log. Deletions are NOT reversible — review the
 * dry-run output first. After applying, trigger a Navidrome rescan so the library
 * reconciles. A few albums assembled from genuinely different rips may still show
 * a residual split; delete + re-hunt those (the fixed flow now fetches one clean
 * folder).
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */

import { readFileSync, readdirSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { dedupeFolder, dupKey, pickKeeper, type DupFile } from '../services/album-dedupe.js';

// Re-exported so existing importers/tests keep working after the core moved to
// the shared album-dedupe module.
export { dupKey, pickKeeper, type DupFile };

function expandHome(p: string): string {
  return p.startsWith('~') ? join(process.env.HOME ?? '/root', p.slice(1)) : p;
}

interface Config {
  dataDir: string;
  musicDir: string;
}

function loadConfig(): Config {
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

  return { dataDir, musicDir };
}

/** Yields every <musicDir>/<Artist>/<Album>/ directory, excluding Singles. */
function* walkAlbumDirs(
  musicDir: string,
): Generator<{ artist: string; album: string; dir: string }> {
  let artistEntries: string[];
  try {
    artistEntries = readdirSync(musicDir);
  } catch {
    return;
  }

  for (const artist of artistEntries) {
    const artistDir = join(musicDir, artist);
    let st;
    try {
      st = statSync(artistDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    let albumEntries: string[];
    try {
      albumEntries = readdirSync(artistDir);
    } catch {
      continue;
    }
    for (const album of albumEntries) {
      if (album === 'Singles') continue;
      const dir = join(artistDir, album);
      let ast;
      try {
        ast = statSync(dir);
      } catch {
        continue;
      }
      if (!ast.isDirectory()) continue;
      yield { artist, album, dir };
    }
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const { dataDir, musicDir } = loadConfig();
  const dbPath = join(dataDir, 'nicotind.db');

  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readwrite: true });
  // A running nicotind instance may hold the DB; wait briefly instead of erroring.
  db.run('PRAGMA busy_timeout = 5000');
  const logPath = join(dataDir, 'repair-album-dupes.log');

  console.log(`Mode      : ${apply ? 'APPLY (deleting)' : 'DRY RUN (no changes)'}`);
  console.log(`Music dir : ${musicDir}`);
  console.log(`Database  : ${dbPath}`);
  if (apply) console.log(`Delete log: ${logPath}`);
  console.log('');

  let foldersAffected = 0;
  let filesDeleted = 0;
  let bytesFreed = 0;

  for (const { artist, album, dir } of walkAlbumDirs(musicDir)) {
    const { deleted } = dedupeFolder(dir, {
      apply,
      onDelete: (filePath, file, keeper) => {
        if (apply) {
          appendFileSync(
            logPath,
            `${filePath}\t(${file.size} bytes, kept ${keeper.name})\n`,
            'utf-8',
          );
          db.run('DELETE FROM completed_downloads WHERE basename = ?', [
            basename(file.name).toLowerCase(),
          ]);
        }
      },
    });
    if (!deleted.length) continue;

    foldersAffected++;
    console.log(`  ${artist}/${album}/  dropping ${deleted.length}:`);
    for (const d of deleted) {
      console.log(`      - ${d.name}  (keep "${d.keptName}")`);
      bytesFreed += d.size;
      filesDeleted++;
    }
  }

  const mb = (bytesFreed / (1024 * 1024)).toFixed(1);
  console.log(
    `\nDone (${apply ? 'applied' : 'dry run'}). folders=${foldersAffected} duplicate-files=${filesDeleted} reclaimed=${mb} MB`,
  );
  if (!apply && filesDeleted > 0) {
    console.log('\nRe-run with --apply to delete these. (Deletions are not reversible.)');
  }
  if (apply && filesDeleted > 0) {
    console.log('\nTrigger a Navidrome rescan so the library reconciles the removed files.');
  }
}

// Only run as a CLI entrypoint — importing this module (e.g. in tests for the
// pure helpers above) must not kick off a filesystem/DB sweep.
if (import.meta.main) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

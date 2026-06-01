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

import { readFileSync, readdirSync, statSync, existsSync, appendFileSync, unlinkSync } from 'node:fs';
import { resolve, join, extname, basename } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { AUDIO_EXTS } from '../services/audio-tags.js';

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

export interface DupFile {
  name: string;
  size: number;
}

/**
 * Normalized identity of a track, collapsing only TRUE duplicate copies:
 * leading track number, a trailing " (N)" integer collision suffix, the
 * extension, and case/punctuation are all stripped. Meaningful qualifiers
 * ("live", "acoustic version", …) survive, so distinct tracks stay distinct.
 */
export function dupKey(filename: string): string {
  const stem = filename.slice(0, filename.length - extname(filename).length);
  return stem
    .replace(/^\d+[\s.\-_]+/, '') // leading track number
    .replace(/\s*\(\d+\)\s*$/, '') // trailing " (2)" collision suffix
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // apostrophe / punctuation variants
    .replace(/\s+/g, ' ')
    .trim();
}

const hasSuffix = (name: string): boolean => /\s*\(\d+\)\s*$/.test(name.slice(0, name.length - extname(name).length));

/**
 * Orders duplicate copies best-first: FLAC over lossy, then larger file (better
 * bitrate / not truncated), then the un-suffixed original, then name. The first
 * element is the keeper; the rest are safe to delete.
 */
export function pickKeeper(files: DupFile[]): DupFile[] {
  return [...files].sort((a, b) => {
    const aFlac = extname(a.name).toLowerCase() === '.flac' ? 0 : 1;
    const bFlac = extname(b.name).toLowerCase() === '.flac' ? 0 : 1;
    if (aFlac !== bFlac) return aFlac - bFlac;
    if (a.size !== b.size) return b.size - a.size;
    const aSuf = hasSuffix(a.name) ? 1 : 0;
    const bSuf = hasSuffix(b.name) ? 1 : 0;
    if (aSuf !== bSuf) return aSuf - bSuf;
    return a.name.localeCompare(b.name);
  });
}

/** Yields every <musicDir>/<Artist>/<Album>/ directory, excluding Singles. */
function* walkAlbumDirs(musicDir: string): Generator<{ artist: string; album: string; dir: string }> {
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
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    const audio: DupFile[] = [];
    for (const name of entries) {
      if (!AUDIO_EXTS.has(extname(name).toLowerCase())) continue;
      let fst;
      try {
        fst = statSync(join(dir, name));
      } catch {
        continue;
      }
      if (!fst.isFile()) continue;
      audio.push({ name, size: fst.size });
    }

    const groups = new Map<string, DupFile[]>();
    for (const f of audio) {
      const key = dupKey(f.name);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(f);
    }

    let folderHadDupes = false;
    for (const [, files] of groups) {
      if (files.length < 2) continue;
      folderHadDupes = true;
      const [keeper, ...toDelete] = pickKeeper(files);
      console.log(`  ${artist}/${album}/  keep "${keeper.name}", drop ${toDelete.length}:`);
      for (const d of toDelete) {
        console.log(`      - ${d.name}`);
        bytesFreed += d.size;
        filesDeleted++;
        if (apply) {
          const filePath = join(dir, d.name);
          try {
            unlinkSync(filePath);
            appendFileSync(logPath, `${filePath}\t(${d.size} bytes, kept ${keeper.name})\n`, 'utf-8');
          } catch (err) {
            console.warn(`        FAILED delete: ${err}`);
            continue;
          }
          db.run('DELETE FROM completed_downloads WHERE basename = ?', [basename(d.name).toLowerCase()]);
        }
      }
    }
    if (folderHadDupes) foldersAffected++;
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

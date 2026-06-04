/**
 * Repair tracks mislabeled as Singles that belong to real albums.
 *
 *   bun run packages/api/src/scripts/repair-singles.ts
 *
 * How it works:
 *   1. Walks every <musicDir>/<Artist>/Singles/ directory.
 *   2. For each file, looks up the original peer-side directory in
 *      completed_downloads by basename (case-insensitive).
 *   3. Derives a real album name from that peer directory using the same
 *      inferFolderAlbum logic as the organizer.
 *   4. If a real album is found, re-tags the file and moves it to
 *      <musicDir>/<Artist>/<Album>/.
 *   5. Updates completed_downloads.relative_path so the DB stays consistent.
 *
 * The script is idempotent: files already in non-Singles locations are skipped.
 * Every move is appended to <dataDir>/repair-singles.log for manual reverting.
 *
 * Env: NICOTIND_DATA_DIR, NICOTIND_MUSIC_DIR, NICOTIND_CONFIG.
 */

import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  copyFileSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { resolve, join, extname, basename, relative } from 'node:path';
import { parse } from 'yaml';
import { Database } from 'bun:sqlite';
import { inferFolderAlbum } from '../services/path-inference.js';
import { readAudioTags, writeAudioTags, AUDIO_EXTS } from '../services/audio-tags.js';
import { sanitizeSegment } from '../services/path-sanitize.js';
import { normalizeTagValue } from '../services/audio-tags.js';

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

/** Yields every audio file under every <musicDir>/<Artist>/Singles/ directory. */
function* walkSinglesFiles(
  musicDir: string,
): Generator<{ artistDir: string; artist: string; filePath: string }> {
  let artistEntries: string[];
  try {
    artistEntries = readdirSync(musicDir);
  } catch {
    return;
  }

  for (const artistName of artistEntries) {
    const artistDir = join(musicDir, artistName);
    let st;
    try {
      st = statSync(artistDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const singlesDir = join(artistDir, 'Singles');
    if (!existsSync(singlesDir)) continue;

    let singlesEntries: string[];
    try {
      singlesEntries = readdirSync(singlesDir);
    } catch {
      continue;
    }

    for (const fname of singlesEntries) {
      const filePath = join(singlesDir, fname);
      let fst;
      try {
        fst = statSync(filePath);
      } catch {
        continue;
      }
      if (!fst.isFile()) continue;
      if (!AUDIO_EXTS.has(extname(fname).toLowerCase())) continue;
      yield { artistDir, artist: artistName, filePath };
    }
  }
}

function moveFileAcrossDevices(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
    copyFileSync(src, dst);
    unlinkSync(src);
  }
}

function uniquePath(desired: string, sourcePath: string): string {
  if (!existsSync(desired) || desired === sourcePath) return desired;
  const ext = extname(desired);
  const stem = desired.slice(0, desired.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const cand = `${stem} (${i})${ext}`;
    if (!existsSync(cand) || cand === sourcePath) return cand;
  }
  return desired;
}

function logMove(logPath: string, src: string, dst: string): void {
  try {
    appendFileSync(logPath, `${src}\t${dst}\n`, 'utf-8');
  } catch {
    /* non-fatal */
  }
}

async function main(): Promise<void> {
  const { dataDir, musicDir } = loadConfig();
  const dbPath = join(dataDir, 'nicotind.db');

  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}. Run nicotind at least once first.`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: false });
  const logPath = join(dataDir, 'repair-singles.log');

  console.log(`Music dir : ${musicDir}`);
  console.log(`Database  : ${dbPath}`);
  console.log(`Move log  : ${logPath}\n`);

  let examined = 0;
  let repaired = 0;
  let noDbRecord = 0;
  let noAlbumFound = 0;
  let failed = 0;

  for (const { artist, filePath } of walkSinglesFiles(musicDir)) {
    examined++;
    const fileBasename = basename(filePath).toLowerCase();

    // Look up the original peer directory from completed_downloads
    const row = db
      .query(
        `SELECT directory FROM completed_downloads WHERE basename = ? ORDER BY completed_at DESC LIMIT 1`,
      )
      .get(fileBasename) as { directory: string } | null;

    if (!row) {
      // File predates the download tracker or was downloaded externally
      noDbRecord++;
      continue;
    }

    const tags = await readAudioTags(filePath);
    const artistFromTag =
      normalizeTagValue(tags.albumArtist) ?? normalizeTagValue(tags.artist) ?? artist;

    const album = inferFolderAlbum(row.directory, artistFromTag);
    if (!album) {
      noAlbumFound++;
      continue;
    }

    const destDir = join(musicDir, sanitizeSegment(artistFromTag), sanitizeSegment(album));
    const destPath = uniquePath(join(destDir, basename(filePath)), filePath);

    if (destPath === filePath) {
      // Already in the right place (shouldn't happen given we're in Singles/)
      continue;
    }

    try {
      mkdirSync(destDir, { recursive: true });
      moveFileAcrossDevices(filePath, destPath);
      logMove(logPath, filePath, destPath);
    } catch (err) {
      console.warn(`  FAILED move ${filePath} → ${destPath}: ${err}`);
      failed++;
      continue;
    }

    // Write the correct album tag so Navidrome groups it properly
    try {
      await writeAudioTags(destPath, { album, albumArtist: artistFromTag });
    } catch {
      /* non-fatal — file is already moved */
    }

    // Update the DB so relative_path reflects the new location
    const newRel = relative(musicDir, destPath).replace(/\\/g, '/');
    db.run(
      `UPDATE completed_downloads SET relative_path = ? WHERE basename = ? AND directory = ?`,
      [newRel, fileBasename, row.directory],
    );

    console.log(
      `  [REPAIRED] ${artist}/Singles/${basename(filePath)} → ${artistFromTag}/${album}/`,
    );
    repaired++;
  }

  console.log(
    `\nDone. examined=${examined} repaired=${repaired} no-db-record=${noDbRecord} no-album-found=${noAlbumFound} failed=${failed}`,
  );
  console.log('\nRestart nicotind (or trigger a full Navidrome rescan) to update the library.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

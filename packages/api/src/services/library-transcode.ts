import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import { isLossless, isLosslessFile, transcodeToOpus } from './post-download-transcode.js';
import { ffmpegAvailable } from './transcode.js';
import { LibraryScanner, songId } from './library-scanner.js';

const log = createLogger('library-transcode');

export interface LibraryTranscodeResult {
  /** Lossless rows considered. */
  candidates: number;
  converted: number;
  skipped: number;
  failed: number;
  bytesReclaimed: number;
}

interface SongRow {
  id: string;
  path: string;
  suffix: string | null;
  size: number | null;
  starred: string | null;
  hidden: number;
}

/**
 * Convert the **existing** library's lossless files (FLAC/WAV/…) to Opus in
 * place, mirroring the post-download standardization. Already-lossy files are
 * left untouched.
 *
 * Re-encoding changes a file's extension → its relative path → its derived
 * `songId` and `acquisitions` key. Album-keyed data (artwork, release-meta,
 * classification) is keyed on the tag-derived `albumId` and survives; song-keyed
 * data does not, so per file we **migrate identity**: carry `starred`/`hidden`
 * onto the new song row, re-point `playlist_songs.song_id` and
 * `acquisitions.relative_path`, and drop the stale lossless row. `scanPaths`
 * inserts the new opus row and recomputes the album aggregate after the old row
 * is gone, so counts stay correct.
 */
export async function transcodeLibraryToOpus(
  db: Database,
  musicDir: string,
  opts: { apply: boolean; bitRate?: number },
): Promise<LibraryTranscodeResult> {
  const result: LibraryTranscodeResult = {
    candidates: 0,
    converted: 0,
    skipped: 0,
    failed: 0,
    bytesReclaimed: 0,
  };
  if (opts.apply && !ffmpegAvailable()) {
    throw new Error('ffmpeg is required to transcode the library but was not found on PATH');
  }

  const allRows = db
    .query<SongRow, []>(`SELECT id, path, suffix, size, starred, hidden FROM library_songs`)
    .all();
  const rows: SongRow[] = [];
  for (const r of allRows) {
    if (isLossless(r.suffix) || isLossless(r.path.split('.').pop() ?? '')) {
      rows.push(r);
      continue;
    }
    // .m4a-family rows need a codec probe: ALAC (lossless, browser-undecodable)
    // shares the extension with lossy AAC. Probe only files that exist.
    const ext = (r.path.split('.').pop() ?? '').toLowerCase();
    if (['m4a', 'm4b', 'mp4'].includes(ext)) {
      const abs = join(musicDir, r.path);
      if (existsSync(abs) && (await isLosslessFile(abs))) rows.push(r);
    }
  }
  result.candidates = rows.length;

  const scanner = new LibraryScanner(musicDir, db);
  const bitRate = opts.bitRate ?? 128;

  for (const row of rows) {
    const abs = join(musicDir, row.path);
    if (!existsSync(abs)) {
      log.warn({ path: row.path }, 'lossless row points at a missing file — skipping');
      result.skipped += 1;
      continue;
    }
    if (!opts.apply) {
      result.converted += 1; // dry-run: report what would be converted
      result.bytesReclaimed += row.size ?? 0;
      continue;
    }

    let newAbs: string;
    let oldSize = 0;
    try {
      oldSize = statSync(abs).size;
      newAbs = await transcodeToOpus(abs, bitRate);
    } catch (err) {
      log.warn({ err, path: row.path }, 'library transcode failed — original kept');
      result.failed += 1;
      continue;
    }

    const newRel = newAbs
      .slice(musicDir.length)
      .replace(/^[/\\]+/, '')
      .replace(/\\/g, '/');
    const newId = songId(newRel);
    const newSize = existsSync(newAbs) ? statSync(newAbs).size : 0;

    // Drop the stale lossless row first so scanPaths recomputes the album
    // aggregate counting only the new opus row.
    db.run('DELETE FROM library_songs WHERE id = ?', [row.id]);
    await scanner.scanPaths([newRel]);

    db.transaction(() => {
      // Carry curation forward onto the new song id.
      db.run('UPDATE library_songs SET starred = ?, hidden = ? WHERE id = ?', [
        row.starred,
        row.hidden,
        newId,
      ]);
      // Re-point playlist + acquisition references (no FK on song_id).
      db.run('UPDATE OR IGNORE playlist_songs SET song_id = ? WHERE song_id = ?', [newId, row.id]);
      // The lossless file may have a pre-existing opus duplicate whose provenance
      // row already sits at `newRel` (the relative_path PK). A plain UPDATE would
      // collide (SQLITE_CONSTRAINT_PRIMARYKEY) and abort the whole migration, so
      // keep the existing target row and drop the now-stale lossless one; only
      // re-point when the opus path has no row yet.
      const targetExists = db
        .query('SELECT 1 FROM acquisitions WHERE relative_path = ?')
        .get(newRel);
      if (targetExists) {
        db.run('DELETE FROM acquisitions WHERE relative_path = ?', [row.path]);
      } else {
        db.run('UPDATE acquisitions SET relative_path = ? WHERE relative_path = ?', [
          newRel,
          row.path,
        ]);
      }
    })();

    result.converted += 1;
    result.bytesReclaimed += Math.max(0, oldSize - newSize);
  }

  log.info({ ...result, apply: opts.apply }, 'library transcode pass complete');
  return result;
}

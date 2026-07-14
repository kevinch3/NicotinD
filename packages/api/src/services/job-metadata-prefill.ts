import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import type { CompletedDownloadFile } from './path-inference.js';
import { setSongGenres } from './genre-split.js';
import { resolveSongAbsPath } from './track-backfill.js';
import { writeAudioTags } from './audio-tags.js';
import { existsSync } from 'node:fs';

const log = createLogger('job-metadata-prefill');

export interface PrefillDeps {
  musicDir: string;
  /** Injectable for tests; defaults to the real tag writer. */
  writeTags?: (abs: string, tags: { genre?: string; year?: number }) => Promise<boolean>;
  fileExists?: (abs: string) => boolean;
}

/**
 * Scan-seam metadata pre-fill: the hunt already knew the album's Lidarr
 * genres/year at enqueue time (carried on the acquisition job), so freshly
 * scanned songs get them applied immediately instead of waiting for the
 * windowed genre enrichment task to re-derive them per artist.
 *
 * Fill-only-empty: an existing tag (or a user metadata fix) always wins.
 * Writes through the same path the genre task uses — `setSongGenres` (join
 * table + mirrored primary column) plus the file tag — so the task's pending
 * query (`genre IS NULL OR ''`) naturally skips these songs, and a full
 * rescan re-reads the value from the tag instead of wiping it.
 */
export async function applyJobMetadataPrefill(
  db: Database,
  files: CompletedDownloadFile[],
  deps: PrefillDeps,
): Promise<void> {
  const writeTags = deps.writeTags ?? writeAudioTags;
  const fileExists = deps.fileExists ?? existsSync;

  for (const file of files) {
    const meta = file.jobMeta;
    if (!meta || !file.relativePath) continue;
    const genres = meta.genres?.filter(Boolean) ?? [];
    if (genres.length === 0 && meta.year == null) continue;

    try {
      const song = db
        .query<
          { id: string; genre: string | null; year: number | null },
          [string]
        >('SELECT id, genre, year FROM library_songs WHERE path = ?')
        .get(file.relativePath);
      if (!song) continue;

      const fillGenre = genres.length > 0 && (!song.genre || song.genre === '');
      const fillYear = meta.year != null && song.year == null;
      if (!fillGenre && !fillYear) continue;

      if (fillGenre) setSongGenres(db, song.id, genres);
      if (fillYear) db.run('UPDATE library_songs SET year = ? WHERE id = ?', [meta.year, song.id]);

      const tags: { genre?: string; year?: number } = {};
      if (fillGenre) tags.genre = genres.join('; ');
      if (fillYear) tags.year = meta.year!;
      const abs = resolveSongAbsPath(deps.musicDir, file.relativePath);
      if (fileExists(abs)) await writeTags(abs, tags).catch(() => false);
    } catch (err) {
      // Best-effort: pre-fill must never break the scan that already happened.
      log.warn({ path: file.relativePath, err }, 'Job metadata pre-fill failed for file');
    }
  }
}

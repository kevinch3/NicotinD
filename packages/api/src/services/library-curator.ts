import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import { isUnknownLike } from './audio-tags.js';
import { normalizeForGrouping } from './album-grouping.js';

const log = createLogger('library-curator');

const COMPILATION_NAME_HINTS = /\b(various artists|va|compilation|greatest hits|best of|hits|mixtape)\b/i;
const COMPILATION_ARTIST_HINTS = /\b(various|various artists|va|compilation)\b/i;

// Hide synthetic "<Artist> · Singles" buckets from the album grid. A real
// album titled "Singles" with >=4 tracks (e.g. Future's *Singles*) stays
// visible. Users can override either way via setManualOverride.
const SINGLES_HIDE_MAX_TRACKS = 3;

interface CuratorResult {
  hiddenAlbums: number;
  singles: number;
  compilations: number;
  albums: number;
  unknown: number;
}

interface AlbumRow {
  id: string;
  name: string;
  artist: string;
  song_count: number;
  manual_override: number;
}

/**
 * Reclassifies + auto-hides albums after a sync. Skips rows with
 * manual_override=1 so user-driven choices stick across syncs.
 */
export class LibraryCurator {
  constructor(private db: Database) {}

  reclassifyAll(): CuratorResult {
    const startedAt = Date.now();
    const rows = this.db
      .query<AlbumRow, []>(
        `SELECT id, name, artist, song_count, manual_override FROM library_albums`,
      )
      .all();

    // Releases the user deliberately hunted must never be auto-hidden, even if a
    // small/edge-case row would otherwise trip a hide rule (e.g. a 1–3 track EP
    // that landed in a thin folder). Keyed on the same normalized artist+title the
    // scanner mints album ids from, so an edition variant still matches.
    const protectedKeys = this.loadProtectedKeys();

    const updateStmt = this.db.prepare(
      `UPDATE library_albums SET classification = ?, hidden = ? WHERE id = ? AND manual_override = 0`,
    );

    const result: CuratorResult = {
      hiddenAlbums: 0,
      singles: 0,
      compilations: 0,
      albums: 0,
      unknown: 0,
    };

    this.db.transaction(() => {
      for (const row of rows) {
        if (row.manual_override === 1) continue;
        const classified = classify(row);
        const classification = classified.classification;
        // Deliberately-hunted release → keep visible regardless of classification.
        const hidden =
          classified.hidden && protectedKeys.has(albumKey(row.artist, row.name))
            ? false
            : classified.hidden;
        updateStmt.run(classification, hidden ? 1 : 0, row.id);
        if (hidden) result.hiddenAlbums++;
        if (classification === 'single') result.singles++;
        else if (classification === 'compilation') result.compilations++;
        else if (classification === 'album') result.albums++;
        else result.unknown++;
      }
    })();

    log.info({ ...result, durationMs: Date.now() - startedAt }, 'Curator reclassified library');
    return result;
  }

  setManualOverride(
    albumId: string,
    opts: { classification?: Classification; hidden?: boolean },
  ): boolean {
    const sets: string[] = ['manual_override = 1'];
    const params: Array<string | number> = [];
    if (opts.classification !== undefined) {
      sets.push('classification = ?');
      params.push(opts.classification);
    }
    if (opts.hidden !== undefined) {
      sets.push('hidden = ?');
      params.push(opts.hidden ? 1 : 0);
    }
    if (sets.length === 1) return false;
    params.push(albumId);
    const res = this.db.run(`UPDATE library_albums SET ${sets.join(', ')} WHERE id = ?`, params);
    return Number(res.changes ?? 0) > 0;
  }

  clearManualOverride(albumId: string): boolean {
    const res = this.db.run(
      `UPDATE library_albums SET manual_override = 0 WHERE id = ?`,
      [albumId],
    );
    return Number(res.changes ?? 0) > 0;
  }

  // Normalized artist+title keys of every album the user hunted (any job state).
  private loadProtectedKeys(): Set<string> {
    const keys = new Set<string>();
    try {
      const jobs = this.db
        .query<{ artist_name: string | null; album_title: string | null }, []>(
          `SELECT artist_name, album_title FROM album_jobs
           WHERE artist_name IS NOT NULL AND album_title IS NOT NULL`,
        )
        .all();
      for (const j of jobs) {
        if (j.artist_name && j.album_title) keys.add(albumKey(j.artist_name, j.album_title));
      }
    } catch (err) {
      // album_jobs may not exist in minimal test DBs; degrade to "nothing protected".
      log.debug({ err }, 'loadProtectedKeys: album_jobs unavailable');
    }
    return keys;
  }
}

function albumKey(artist: string, title: string): string {
  return `${normalizeForGrouping(artist)}::${normalizeForGrouping(title)}`;
}

type Classification = 'album' | 'single' | 'compilation' | 'unknown';

function classify(row: AlbumRow): { classification: Classification; hidden: boolean } {
  const nameUnknown = isUnknownLike(row.name);
  const artistUnknown = isUnknownLike(row.artist);

  // The `[Unknown Album] / [Unknown Artist]` mega-bucket: hide outright.
  if (nameUnknown && artistUnknown) {
    return { classification: 'unknown', hidden: true };
  }

  // Compilation hints come from album name + artist name.
  if (
    COMPILATION_NAME_HINTS.test(row.name) ||
    COMPILATION_ARTIST_HINTS.test(row.artist)
  ) {
    return { classification: 'compilation', hidden: false };
  }

  // Synthetic "Singles" bucket: organizer Singles-fallback creates
  // <Artist>/Singles/ for tracks without an album tag. Hide when small.
  if (row.name.trim().toLowerCase() === 'singles' && row.song_count <= SINGLES_HIDE_MAX_TRACKS) {
    return { classification: 'single', hidden: true };
  }

  // Single-track album that *also* has unknown identity → noise, hide it.
  if (row.song_count <= 1 && (nameUnknown || artistUnknown)) {
    return { classification: 'unknown', hidden: true };
  }

  if (row.song_count <= 1) {
    return { classification: 'single', hidden: false };
  }

  return { classification: 'album', hidden: false };
}

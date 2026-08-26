import { createLogger } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import { isUnknownLike } from './audio-tags.js';
import { looksLikeSourceWatermark, isNumericLikeName } from './library-quality.js';
import { normalizeArtistForGrouping, normalizeForGrouping } from './album-grouping.js';
import { loadReleaseTypes, type ReleaseType } from './release-meta-store.js';
import { jobAlbumPairs } from './acquisition-job-store.js';

const log = createLogger('library-curator');

const COMPILATION_NAME_HINTS =
  /\b(various artists|va|compilation|greatest hits|best of|hits|mixtape)\b/i;
const COMPILATION_ARTIST_HINTS = /\b(various|various artists|va|compilation)\b/i;

// Heuristic release-type bands (used only when no authoritative metadata type
// exists in library_release_meta): 1 track → single, 2–6 → EP, 7+ → album.
const EP_MAX_TRACKS = 6;

interface CuratorResult {
  hiddenAlbums: number;
  singles: number;
  eps: number;
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
    // Authoritative release types (Lidarr/MusicBrainz) override the heuristic.
    const metaTypes = loadReleaseTypes(this.db);

    const updateStmt = this.db.prepare(
      `UPDATE library_albums SET classification = ?, hidden = ? WHERE id = ? AND manual_override = 0`,
    );

    const result: CuratorResult = {
      hiddenAlbums: 0,
      singles: 0,
      eps: 0,
      compilations: 0,
      albums: 0,
      unknown: 0,
    };

    this.db.transaction(() => {
      for (const row of rows) {
        if (row.manual_override === 1) continue;
        const classified = classify(row, metaTypes.get(row.id));
        const classification = classified.classification;
        // Deliberately-hunted release → keep visible regardless of classification.
        const hidden =
          classified.hidden && protectedKeys.has(albumKey(row.artist, row.name))
            ? false
            : classified.hidden;
        updateStmt.run(classification, hidden ? 1 : 0, row.id);
        if (hidden) result.hiddenAlbums++;
        if (classification === 'single') result.singles++;
        else if (classification === 'ep') result.eps++;
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
    const res = this.db.run(`UPDATE library_albums SET manual_override = 0 WHERE id = ?`, [
      albumId,
    ]);
    return Number(res.changes ?? 0) > 0;
  }

  // Normalized artist+title keys of every album the user hunted (any job state).
  private loadProtectedKeys(): Set<string> {
    const keys = new Set<string>();
    // `album_jobs` UNION the unified `acquisition_jobs` via the shared job-store
    // helper (also covers track-search/direct grabs); it degrades to [] when the
    // tables are absent (minimal test DBs) → "nothing protected".
    for (const { artistName, albumTitle } of jobAlbumPairs(this.db)) {
      keys.add(albumKey(artistName, albumTitle));
    }
    return keys;
  }
}

function albumKey(artist: string, title: string): string {
  return `${normalizeArtistForGrouping(artist)}::${normalizeForGrouping(title)}`;
}

export type Classification = 'album' | 'ep' | 'single' | 'compilation' | 'unknown';

/** The classification vocabulary, shared by every surface that validates one. */
export const VALID_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  'album',
  'ep',
  'single',
  'compilation',
  'unknown',
]);

/**
 * Classify one album. `metaType` (from library_release_meta) is authoritative
 * when present — the Lidarr/MusicBrainz release type — and the function falls
 * back to a track-count heuristic otherwise. Pure: the metadata lookup happens
 * in the caller so this stays unit-testable.
 */
/**
 * Track count above which a `single`/`ep` claim is not credible.
 *
 * Deliberately well clear of `EP_MAX_TRACKS` (6) rather than adjacent to it: a
 * maxi-single with remixes genuinely *is* a single, and prod has real 7- and
 * 8-track examples ("Alejandro", "Paparazzi" — Lady Gaga) that must keep their
 * catalog type. Only a gross contradiction overrides the catalog — the 12/14/18
 * track cases — so this stays a backstop against a mismatched lookup, not a
 * general distrust of metadata.
 */
const IMPLAUSIBLE_SHORT_RELEASE_TRACKS = 10;

/** True when a catalog `single`/`ep` claim is contradicted by the folder. */
export function contradictsTrackCount(metaType: ReleaseType, songCount: number): boolean {
  if (metaType !== 'single' && metaType !== 'ep') return false;
  return songCount >= IMPLAUSIBLE_SHORT_RELEASE_TRACKS;
}

function classify(
  row: AlbumRow,
  metaType?: ReleaseType,
): { classification: Classification; hidden: boolean } {
  const nameUnknown = isUnknownLike(row.name);
  const artistUnknown = isUnknownLike(row.artist);

  // The `[Unknown Album] / [Unknown Artist]` mega-bucket: hide outright,
  // regardless of any stray metadata.
  if (nameUnknown && artistUnknown) {
    return { classification: 'unknown', hidden: true };
  }

  // DJ-pool / VA-source watermark, or a bare-number artist (mis-parsed disc-track
  // tag): hide so existing pollution that predates the ingest-time guard
  // (sanitizeArtistTag/sanitizeAlbumTag) disappears from the UI on the next scan,
  // without deleting files. The auditor's `watermark_*`/`numeric_artist` rules
  // still report it for the delete pass. (see docs/library-audit.md)
  if (
    looksLikeSourceWatermark(row.artist) ||
    looksLikeSourceWatermark(row.name) ||
    isNumericLikeName(row.artist)
  ) {
    return { classification: 'unknown', hidden: true };
  }

  // Authoritative metadata type wins: a known catalog release is never hidden —
  // EXCEPT when the folder's own track count flatly contradicts it (issue #315).
  // Titles collide across release types (Dua Lipa has both an album and a single
  // called "Future Nostalgia"), so the catalog lookup can attach the single's
  // type to the album's folder; nothing re-evaluates it as the remaining tracks
  // land, and the Albums grid — which filters on `classification = 'album'` —
  // then omits an 18-track album entirely.
  if (metaType) {
    if (contradictsTrackCount(metaType, row.song_count)) {
      return { classification: 'album', hidden: false };
    }
    return { classification: metaType, hidden: false };
  }

  // Compilation hints come from album name + artist name.
  if (COMPILATION_NAME_HINTS.test(row.name) || COMPILATION_ARTIST_HINTS.test(row.artist)) {
    return { classification: 'compilation', hidden: false };
  }

  // Single-track album that *also* has unknown identity → noise, hide it.
  if (row.song_count <= 1 && (nameUnknown || artistUnknown)) {
    return { classification: 'unknown', hidden: true };
  }

  // Heuristic release-type bands by track count.
  if (row.song_count <= 1) {
    return { classification: 'single', hidden: false };
  }
  if (row.song_count <= EP_MAX_TRACKS) {
    return { classification: 'ep', hidden: false };
  }
  return { classification: 'album', hidden: false };
}

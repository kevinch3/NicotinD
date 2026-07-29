import type { Database } from 'bun:sqlite';

/**
 * Authoritative release-type store (Lidarr/MusicBrainz `albumType`).
 *
 * The curator (`library-curator.ts`) prefers these values over its track-count
 * heuristic when classifying an album as album / ep / single / compilation. Rows
 * are keyed on the scanner's deterministic `albumIdFor`, which is why this lives
 * in its own `library_release_meta` table rather than a column on the
 * scanner-managed `library_albums` rows: it survives full rescans/prunes
 * untouched and can be written at ingest time before the album exists on disk
 * (same pattern as `artwork-store.ts`).
 */

export type ReleaseType = 'album' | 'ep' | 'single' | 'compilation';

const VALID: ReadonlySet<string> = new Set(['album', 'ep', 'single', 'compilation']);

/**
 * Map a Lidarr/MusicBrainz `albumType` to our taxonomy. Returns null for types
 * we can't confidently map (Broadcast/Other/unknown) so the caller falls back to
 * the heuristic.
 */
export function mapLidarrAlbumType(albumType: string | undefined): ReleaseType | null {
  switch ((albumType ?? '').trim().toLowerCase()) {
    case 'album':
      return 'album';
    case 'ep':
      return 'ep';
    case 'single':
      return 'single';
    case 'compilation':
      return 'compilation';
    default:
      return null;
  }
}

/** Resolve the authoritative release type for an album id, or null if unknown. */
export function getReleaseType(db: Database, albumId: string): ReleaseType | null {
  const row = db
    .query<{ album_type: string }, [string]>(
      'SELECT album_type FROM library_release_meta WHERE album_id = ?',
    )
    .get(albumId);
  return row && VALID.has(row.album_type) ? (row.album_type as ReleaseType) : null;
}

/** Read every (albumId → type) mapping; used by the curator's batch reclassify. */
export function loadReleaseTypes(db: Database): Map<string, ReleaseType> {
  const rows = db
    .query<{ album_id: string; album_type: string }, []>(
      'SELECT album_id, album_type FROM library_release_meta',
    )
    .all();
  const map = new Map<string, ReleaseType>();
  for (const r of rows) {
    if (VALID.has(r.album_type)) map.set(r.album_id, r.album_type as ReleaseType);
  }
  return map;
}

/** Upsert an authoritative release type for an album id. */
export function setReleaseType(
  db: Database,
  albumId: string,
  type: ReleaseType,
  opts: { canonicalTitle?: string; source?: string } = {},
): void {
  if (!VALID.has(type)) return;
  db.run(
    `INSERT INTO library_release_meta (album_id, album_type, canonical_title, source, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(album_id) DO UPDATE SET
       album_type = excluded.album_type,
       canonical_title = excluded.canonical_title,
       source = excluded.source,
       updated_at = excluded.updated_at`,
    [albumId, type, opts.canonicalTitle ?? null, opts.source ?? null, Date.now()],
  );
}

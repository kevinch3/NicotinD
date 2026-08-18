import type { Database } from 'bun:sqlite';

export type OriginSource = 'musicbrainz' | 'user';

export interface ArtistOriginRow {
  country: string | null;
  source: OriginSource;
  checkedAt: number;
}

/** Upsert an origin row; a 'musicbrainz' write never overwrites a 'user' row. */
export function upsertArtistOrigin(
  db: Database,
  row: { artistId: string; country: string | null; source: OriginSource },
): void {
  db.run(
    `INSERT INTO library_artist_origins (artist_id, country, source, checked_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(artist_id) DO UPDATE SET
       country = excluded.country, source = excluded.source, checked_at = excluded.checked_at
     WHERE NOT (library_artist_origins.source = 'user' AND excluded.source = 'musicbrainz')`,
    [row.artistId, row.country, row.source, Date.now()],
  );
}

export function getArtistOrigin(db: Database, artistId: string): ArtistOriginRow | null {
  const r = db
    .query<{ country: string | null; source: OriginSource; checked_at: number }, [string]>(
      `SELECT country, source, checked_at FROM library_artist_origins WHERE artist_id = ?`,
    )
    .get(artistId);
  return r ? { country: r.country, source: r.source, checkedAt: r.checked_at } : null;
}

/** Countries present in the library (visible artists only) + the unknown count. */
export function listOriginFacets(db: Database): {
  countries: Array<{ country: string; artists: number }>;
  unknownArtists: number;
} {
  const countries = db
    .query<{ country: string; artists: number }, []>(
      `SELECT o.country, COUNT(*) AS artists
       FROM library_artist_origins o
       JOIN library_artists a ON a.id = o.artist_id AND a.hidden = 0
       WHERE o.country IS NOT NULL
       GROUP BY o.country ORDER BY artists DESC, o.country`,
    )
    .all();
  const unknown = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM library_artists a
       WHERE a.hidden = 0
         AND NOT EXISTS (
           SELECT 1 FROM library_artist_origins o
           WHERE o.artist_id = a.id AND o.country IS NOT NULL)`,
    )
    .get();
  return { countries, unknownArtists: unknown?.n ?? 0 };
}

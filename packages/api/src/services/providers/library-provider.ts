import type { ISearchProvider, ProviderType, SearchProviderResult } from '@nicotind/core';
import type { Database } from 'bun:sqlite';

/**
 * Local search over the canonical library tables (library_artists/albums/songs)
 * — the native replacement for the Navidrome-backed local provider. Matches the
 * unified-search contract: returns results synchronously for the "local" lane.
 */
export class LibrarySearchProvider implements ISearchProvider {
  readonly name = 'library';
  readonly type: ProviderType = 'local';

  constructor(private db: Database) {}

  async search(query: string): Promise<{ results: SearchProviderResult | null }> {
    const q = query.trim();
    if (!q) return { results: { artists: [], albums: [], songs: [] } };
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;

    const artists = this.db
      .query<{ id: string; name: string; album_count: number }, [string]>(
        // Only surface artists with at least one landed (non-quarantined) song —
        // an artist whose tracks are all still processing isn't in the library yet.
        `SELECT id, name, album_count FROM library_artists
         WHERE hidden = 0 AND name LIKE ? ESCAPE '\\' COLLATE NOCASE
           AND EXISTS (SELECT 1 FROM library_songs s
             WHERE (s.artist_id = library_artists.id
               OR s.id IN (SELECT song_id FROM library_song_artists WHERE artist_id = library_artists.id))
             AND s.landed_at IS NOT NULL)
         ORDER BY name COLLATE NOCASE LIMIT 10`,
      )
      .all(like)
      .map((r) => ({ id: r.id, name: r.name, albumCount: r.album_count }));

    const albums = this.db
      .query<
        { id: string; name: string; artist: string; year: number | null; cover_art: string | null },
        [string, string]
      >(
        // Exclude quarantined albums (any un-landed track) — not in the library yet.
        `SELECT id, name, artist, year, cover_art FROM library_albums
         WHERE hidden = 0 AND (name LIKE ? ESCAPE '\\' OR artist LIKE ? ESCAPE '\\') COLLATE NOCASE
           AND id NOT IN (SELECT DISTINCT album_id FROM library_songs WHERE landed_at IS NULL)
         ORDER BY name COLLATE NOCASE LIMIT 10`,
      )
      .all(like, like)
      .map((r) => ({
        id: r.id,
        name: r.name,
        artist: r.artist,
        year: r.year ?? undefined,
        coverArt: r.cover_art ?? undefined,
      }));

    const songs = this.db
      .query<
        {
          id: string;
          title: string;
          artist: string;
          artist_id: string;
          album: string;
          duration: number;
          bit_rate: number | null;
          cover_art: string | null;
        },
        [string, string]
      >(
        `SELECT s.id, s.title, s.artist, s.artist_id, a.name AS album, s.duration, s.bit_rate, s.cover_art
         FROM library_songs s
         LEFT JOIN library_albums a ON a.id = s.album_id
         WHERE s.hidden = 0 AND s.landed_at IS NOT NULL
           AND (s.title LIKE ? ESCAPE '\\' OR s.artist LIKE ? ESCAPE '\\') COLLATE NOCASE
         ORDER BY s.title COLLATE NOCASE LIMIT 40`,
      )
      .all(like, like)
      .map((r) => ({
        id: r.id,
        title: r.title,
        artist: r.artist,
        artistId: r.artist_id,
        album: r.album ?? '',
        duration: r.duration,
        bitRate: r.bit_rate ?? undefined,
        coverArt: r.cover_art ?? undefined,
      }));

    return { results: { artists, albums, songs } };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

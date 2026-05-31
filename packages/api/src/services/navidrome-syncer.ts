import { createLogger } from '@nicotind/core';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { Album, Song, Artist } from '@nicotind/core';
import type { Database } from 'bun:sqlite';

const log = createLogger('navidrome-syncer');

const ALBUM_PAGE_SIZE = 500;
const ALBUM_FETCH_CONCURRENCY = 10;

interface SyncResult {
  durationMs: number;
  albums: number;
  songs: number;
  artists: number;
  genres: number;
  removedAlbums: number;
  removedSongs: number;
}

/**
 * Mirrors Navidrome's view of the library into NicotinD's sqlite tables.
 * Run after every Navidrome scan; idempotent.
 *
 * The UI reads only from the canonical tables — so curation (hide/classify)
 * happens in NicotinD without touching Navidrome.
 */
export class NavidromeSyncer {
  constructor(
    private navidrome: Navidrome,
    private db: Database,
  ) {}

  async syncFull(): Promise<SyncResult> {
    const startedAt = Date.now();
    const syncedAt = startedAt;

    const [albums, artists, genres] = await Promise.all([
      this.fetchAllAlbums(),
      this.navidrome.browsing.getArtists().catch((err) => {
        log.warn({ err }, 'getArtists failed');
        return [] as Artist[];
      }),
      this.navidrome.browsing.getGenres().catch((err) => {
        log.warn({ err }, 'getGenres failed');
        return [] as Array<{ value: string; songCount: number; albumCount: number }>;
      }),
    ]);

    log.info({ albumCount: albums.length, artistCount: artists.length, genreCount: genres.length }, 'Sync: fetched top-level');

    const allSongs: Song[] = [];
    for (let i = 0; i < albums.length; i += ALBUM_FETCH_CONCURRENCY) {
      const batch = albums.slice(i, i + ALBUM_FETCH_CONCURRENCY);
      const results = await Promise.all(
        batch.map((album) =>
          this.navidrome.browsing
            .getAlbum(album.id)
            .then((r) => r.songs)
            .catch((err) => {
              log.debug({ err, albumId: album.id }, 'getAlbum failed');
              return [] as Song[];
            }),
        ),
      );
      for (const songs of results) allSongs.push(...songs);
    }

    log.info({ songCount: allSongs.length }, 'Sync: fetched songs');

    this.db.transaction(() => {
      this.upsertAlbums(albums, syncedAt);
      this.upsertArtists(artists, syncedAt);
      this.upsertSongs(allSongs, syncedAt);
      this.upsertGenres(genres, syncedAt);
    })();

    // Backfill provenance records that were written by the normalize script
    // before Navidrome had assigned IDs to the affected songs.
    this.db.run(`
      UPDATE library_song_provenance
      SET navidrome_id = (
        SELECT id FROM library_songs
        WHERE library_songs.path = library_song_provenance.song_path
        LIMIT 1
      )
      WHERE navidrome_id IS NULL
    `);

    const removedAlbums = this.db
      .run('DELETE FROM library_albums WHERE synced_at < ?', [syncedAt])
      .changes;
    const removedSongs = this.db
      .run('DELETE FROM library_songs WHERE synced_at < ?', [syncedAt])
      .changes;
    this.db.run('DELETE FROM library_artists WHERE synced_at < ?', [syncedAt]);
    this.db.run('DELETE FROM library_genres WHERE synced_at < ?', [syncedAt]);

    this.db.run(
      `INSERT INTO library_sync_state (key, value, updated_at)
       VALUES ('last_full_sync_at', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [String(syncedAt), syncedAt],
    );

    const result: SyncResult = {
      durationMs: Date.now() - startedAt,
      albums: albums.length,
      songs: allSongs.length,
      artists: artists.length,
      genres: genres.length,
      removedAlbums: Number(removedAlbums ?? 0),
      removedSongs: Number(removedSongs ?? 0),
    };
    log.info(result, 'Sync complete');
    return result;
  }

  private async fetchAllAlbums(): Promise<Album[]> {
    const out: Album[] = [];
    let offset = 0;
    while (true) {
      let page: Album[];
      try {
        page = await this.navidrome.browsing.getAlbumList(
          'alphabeticalByName',
          ALBUM_PAGE_SIZE,
          offset,
        );
      } catch (err) {
        log.warn({ err, offset }, 'getAlbumList failed; stopping pagination');
        break;
      }
      if (page.length === 0) break;
      out.push(...page);
      if (page.length < ALBUM_PAGE_SIZE) break;
      offset += page.length;
    }
    return out;
  }

  private upsertAlbums(albums: Album[], syncedAt: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO library_albums (
        id, name, artist, artist_id, cover_art, song_count, duration,
        year, genre, created, starred, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        artist = excluded.artist,
        artist_id = excluded.artist_id,
        cover_art = excluded.cover_art,
        song_count = excluded.song_count,
        duration = excluded.duration,
        year = excluded.year,
        genre = excluded.genre,
        created = excluded.created,
        starred = excluded.starred,
        synced_at = excluded.synced_at
    `);
    for (const a of albums) {
      stmt.run(
        a.id,
        a.name,
        a.artist,
        a.artistId,
        a.coverArt ?? null,
        a.songCount ?? 0,
        a.duration ?? 0,
        a.year ?? null,
        a.genre ?? null,
        a.created ?? null,
        a.starred ?? null,
        syncedAt,
      );
    }
  }

  private upsertArtists(artists: Artist[], syncedAt: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO library_artists (id, name, album_count, cover_art, starred, synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        album_count = excluded.album_count,
        cover_art = excluded.cover_art,
        starred = excluded.starred,
        synced_at = excluded.synced_at
    `);
    for (const a of artists) {
      stmt.run(
        a.id,
        a.name,
        a.albumCount,
        a.coverArt ?? null,
        a.starred ?? null,
        syncedAt,
      );
    }
  }

  private upsertSongs(songs: Song[], syncedAt: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO library_songs (
        id, album_id, title, artist, artist_id, track, disc, duration,
        year, genre, cover_art, path, size, bit_rate, suffix, content_type,
        created, starred, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        album_id = excluded.album_id,
        title = excluded.title,
        artist = excluded.artist,
        artist_id = excluded.artist_id,
        track = excluded.track,
        disc = excluded.disc,
        duration = excluded.duration,
        year = excluded.year,
        genre = excluded.genre,
        cover_art = excluded.cover_art,
        path = excluded.path,
        size = excluded.size,
        bit_rate = excluded.bit_rate,
        suffix = excluded.suffix,
        content_type = excluded.content_type,
        created = excluded.created,
        starred = excluded.starred,
        synced_at = excluded.synced_at
    `);
    for (const s of songs) {
      stmt.run(
        s.id,
        s.albumId,
        s.title,
        s.artist,
        s.artistId,
        s.track ?? null,
        null,
        s.duration ?? 0,
        s.year ?? null,
        s.genre ?? null,
        s.coverArt ?? null,
        s.path,
        s.size,
        s.bitRate,
        s.suffix,
        s.contentType,
        s.created ?? null,
        s.starred ?? null,
        syncedAt,
      );
    }
  }

  private upsertGenres(
    genres: Array<{ value: string; songCount: number; albumCount: number }>,
    syncedAt: number,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO library_genres (name, song_count, album_count, synced_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        song_count = excluded.song_count,
        album_count = excluded.album_count,
        synced_at = excluded.synced_at
    `);
    for (const g of genres) {
      stmt.run(g.value, g.songCount, g.albumCount, syncedAt);
    }
  }
}

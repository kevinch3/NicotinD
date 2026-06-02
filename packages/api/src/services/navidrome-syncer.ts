import { createLogger } from '@nicotind/core';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { Album, Song, Artist } from '@nicotind/core';
import type { Database } from 'bun:sqlite';
import { albumGroupKey, pickCanonicalId } from './album-grouping.js';

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
 * Collapse Navidrome's fragmented album rows into one canonical row per real
 * album (see album-grouping.ts). Returns the canonical albums to persist and a
 * map from every original Navidrome album id to its canonical id, so songs can
 * be remapped onto the surviving row. Albums that don't share a key with any
 * other (the common case) pass through unchanged as their own canonical row.
 */
export function mergeAlbums(albums: Album[]): {
  canonical: Album[];
  idMap: Map<string, string>;
} {
  const groups = new Map<string, Album[]>();
  for (const a of albums) {
    const key = albumGroupKey(a.artist, a.name);
    const bucket = groups.get(key);
    if (bucket) bucket.push(a);
    else groups.set(key, [a]);
  }

  const canonical: Album[] = [];
  const idMap = new Map<string, string>();
  for (const members of groups.values()) {
    if (members.length === 1) {
      const only = members[0]!;
      idMap.set(only.id, only.id);
      canonical.push(only);
      continue;
    }
    const canonicalId = pickCanonicalId(
      members.map((m) => ({ id: m.id, songCount: m.songCount ?? 0 })),
    );
    const rep = members.find((m) => m.id === canonicalId)!;
    for (const m of members) idMap.set(m.id, canonicalId);
    // Representative identity from the fullest rip; earliest release year; most
    // recent `created` so a freshly-hunted merge still surfaces under "newest";
    // first available cover art across the fragments.
    const years = members.map((m) => m.year).filter((y): y is number => y != null);
    const createds = members
      .map((m) => m.created)
      .filter((c): c is string => c != null)
      .sort();
    canonical.push({
      ...rep,
      year: years.length ? Math.min(...years) : rep.year,
      created: createds[createds.length - 1] ?? rep.created,
      coverArt: members.find((m) => m.coverArt)?.coverArt ?? rep.coverArt,
    });
  }
  return { canonical, idMap };
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

    const [allFetchedAlbums, artists, genres] = await Promise.all([
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

    // Albums the user just deleted. Suppress them until Navidrome's (async) scan
    // catches up and stops reporting them — otherwise a sync that runs before the
    // scan finishes would resurrect a just-deleted album. Suppress by *group key*
    // (artist+title), not just id: a deleted album that we canonicalized from
    // several Navidrome fragments must not reappear via a surviving sibling
    // fragment whose id was never the canonical one. Legacy tombstones (no
    // artist) still match by id.
    const tombRows = this.db
      .query<{ album_id: string; name: string | null; artist: string | null }, []>(
        'SELECT album_id, name, artist FROM library_album_tombstones',
      )
      .all();
    const tombstonedIds = new Set(tombRows.map((r) => r.album_id));
    const tombstonedKeys = new Set(
      tombRows
        .filter((r) => r.artist != null && r.name != null)
        .map((r) => albumGroupKey(r.artist as string, r.name as string)),
    );
    const albums =
      tombstonedIds.size || tombstonedKeys.size
        ? allFetchedAlbums.filter(
            (a) => !tombstonedIds.has(a.id) && !tombstonedKeys.has(albumGroupKey(a.artist, a.name)),
          )
        : allFetchedAlbums;

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

    // Canonicalize the hunt flow's fragmented albums: collapse every Navidrome
    // album sharing a group key (artist + normalized title) into one row and
    // remap its songs onto the canonical id. See album-grouping.ts for why.
    const { canonical, idMap } = mergeAlbums(albums);
    for (const s of allSongs) {
      const mapped = idMap.get(s.albumId);
      if (mapped) s.albumId = mapped;
    }
    // Recompute each merged album's song_count/duration from the remapped songs
    // (summing the fragments' own counts would double-count overlapping rips).
    const aggregates = new Map<string, { songCount: number; duration: number }>();
    for (const s of allSongs) {
      const agg = aggregates.get(s.albumId) ?? { songCount: 0, duration: 0 };
      agg.songCount += 1;
      agg.duration += s.duration ?? 0;
      aggregates.set(s.albumId, agg);
    }

    this.db.transaction(() => {
      this.upsertAlbums(canonical, aggregates, syncedAt);
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

    // Clear tombstones for albums the scan no longer reports — the files are gone
    // and the suppression has done its job. Tombstones whose album Navidrome still
    // returns (scan not finished) survive so the next cycle keeps suppressing them.
    let removedTombstones = 0;
    if (tombstonedIds.size) {
      const stillReportedIds = new Set(allFetchedAlbums.map((a) => a.id));
      const stillReportedKeys = new Set(allFetchedAlbums.map((a) => albumGroupKey(a.artist, a.name)));
      for (const t of tombRows) {
        // A group-aware tombstone clears only when no fragment of its album group
        // is reported anymore; legacy (no-artist) tombstones clear on id alone.
        const groupGone =
          t.artist != null && t.name != null
            ? !stillReportedKeys.has(albumGroupKey(t.artist, t.name))
            : !stillReportedIds.has(t.album_id);
        if (groupGone) {
          this.db.run('DELETE FROM library_album_tombstones WHERE album_id = ?', [t.album_id]);
          removedTombstones++;
        }
      }
    }

    this.db.run(
      `INSERT INTO library_sync_state (key, value, updated_at)
       VALUES ('last_full_sync_at', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [String(syncedAt), syncedAt],
    );

    const result: SyncResult = {
      durationMs: Date.now() - startedAt,
      albums: canonical.length,
      songs: allSongs.length,
      artists: artists.length,
      genres: genres.length,
      removedAlbums: Number(removedAlbums ?? 0),
      removedSongs: Number(removedSongs ?? 0),
    };
    log.info({ ...result, removedTombstones }, 'Sync complete');
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

  private upsertAlbums(
    albums: Album[],
    aggregates: Map<string, { songCount: number; duration: number }>,
    syncedAt: number,
  ): void {
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
      // Prefer the count of remapped songs we actually synced; fall back to the
      // album's own count for albums with no fetched songs.
      const agg = aggregates.get(a.id);
      stmt.run(
        a.id,
        a.name,
        a.artist,
        a.artistId,
        a.coverArt ?? null,
        agg?.songCount ?? a.songCount ?? 0,
        agg?.duration ?? a.duration ?? 0,
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

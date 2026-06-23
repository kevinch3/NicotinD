import type { Database } from 'bun:sqlite';
import type { Song } from '@nicotind/core';

/** `user` = created by a user (private). `curated` = system-seeded, global, read-only. */
export type PlaylistKind = 'user' | 'curated';

export interface PlaylistSummary {
  id: string;
  name: string;
  description: string | null;
  songCount: number;
  /** Designed gradient cover URL (e.g. /playlist-covers/<slug>.svg), or null. */
  coverArt: string | null;
  kind: PlaylistKind;
  createdAt: number;
  modifiedAt: number;
}

export interface PlaylistDetail extends PlaylistSummary {
  songs: Song[];
}

export interface CreatePlaylistInput {
  name: string;
  description?: string;
  songIds?: string[];
}

export interface UpdatePlaylistInput {
  name?: string;
  description?: string;
  add?: string[];
  remove?: string[];
  /** Full ordered list of song ids — replaces positions when provided. */
  reorder?: string[];
}

interface PlaylistRow {
  id: string;
  name: string;
  description: string | null;
  cover_art: string | null;
  kind: string | null;
  created_at: number;
  modified_at: number;
}

interface SongRow {
  id: string;
  album_id: string;
  album_name: string | null;
  album_cover_art: string | null;
  title: string;
  artist: string;
  artist_id: string;
  track: number | null;
  duration: number;
  year: number | null;
  genre: string | null;
  cover_art: string | null;
  path: string;
  size: number | null;
  bit_rate: number | null;
  suffix: string | null;
  content_type: string | null;
  created: string | null;
  starred: string | null;
}

function rowToSong(r: SongRow): Song {
  return {
    id: r.id,
    title: r.title,
    album: r.album_name ?? '',
    albumId: r.album_id,
    artist: r.artist,
    artistId: r.artist_id,
    track: r.track ?? undefined,
    year: r.year ?? undefined,
    genre: r.genre ?? undefined,
    coverArt: r.cover_art ?? r.album_cover_art ?? undefined,
    size: r.size ?? 0,
    contentType: r.content_type ?? '',
    suffix: r.suffix ?? '',
    duration: r.duration,
    bitRate: r.bit_rate ?? 0,
    path: r.path,
    created: r.created ?? '',
    starred: r.starred ?? undefined,
  };
}

/**
 * Native per-user playlists. Everything is scoped to the owning user id — a user
 * never sees or mutates another user's playlists. Songs are referenced by the
 * scanner's stable songId; reads JOIN library_songs and drop rows whose song no
 * longer exists (file moved → id changed), so a playlist degrades gracefully
 * instead of surfacing dead entries.
 */
export class PlaylistService {
  constructor(private db: Database) {}

  // Returns the user's own playlists plus every curated (system) playlist, which
  // is global. Curated playlists sort first so the "Made for you" shelf leads.
  list(userId: string): PlaylistSummary[] {
    return this.db
      .query<PlaylistRow & { song_count: number }, [string]>(
        `SELECT p.id, p.name, p.description, p.cover_art, p.kind, p.created_at, p.modified_at,
                (SELECT COUNT(*) FROM playlist_songs ps
                   JOIN library_songs s ON s.id = ps.song_id
                  WHERE ps.playlist_id = p.id) AS song_count
         FROM playlists p
         WHERE p.user_id = ? OR p.kind = 'curated'
         ORDER BY (p.kind = 'curated') DESC, p.modified_at DESC`,
      )
      .all(userId)
      .map((r) => this.summary(r, r.song_count));
  }

  get(userId: string, id: string): PlaylistDetail | null {
    // Visible if the user owns it OR it's a global curated playlist.
    const row = this.db
      .query<PlaylistRow, [string, string]>(
        `SELECT id, name, description, cover_art, kind, created_at, modified_at
         FROM playlists WHERE id = ? AND (user_id = ? OR kind = 'curated')`,
      )
      .get(id, userId);
    if (!row) return null;

    // JOIN drops any song whose file is gone (moved → new id).
    const songs = this.db
      .query<SongRow, [string]>(
        `SELECT s.id, s.album_id, a.name AS album_name, a.cover_art AS album_cover_art,
                s.title, s.artist, s.artist_id, s.track, s.duration, s.year, s.genre,
                s.cover_art, s.path, s.size, s.bit_rate, s.suffix, s.content_type,
                s.created, s.starred
         FROM playlist_songs ps
         JOIN library_songs s ON s.id = ps.song_id
         LEFT JOIN library_albums a ON a.id = s.album_id
         WHERE ps.playlist_id = ?
         ORDER BY ps.position ASC`,
      )
      .all(id)
      .map(rowToSong);

    return { ...this.summary(row, songs.length), songs };
  }

  create(userId: string, input: CreatePlaylistInput): PlaylistSummary {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.run(
      `INSERT INTO playlists (id, user_id, name, description, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, userId, input.name.trim() || 'Untitled', input.description ?? null, now, now],
    );
    if (input.songIds?.length) this.appendSongs(id, input.songIds);
    return this.summary(
      {
        id,
        name: input.name,
        description: input.description ?? null,
        cover_art: null,
        kind: 'user',
        created_at: now,
        modified_at: now,
      },
      input.songIds?.length ?? 0,
    );
  }

  /** Returns false when the playlist doesn't exist or isn't owned by the user. */
  update(userId: string, id: string, input: UpdatePlaylistInput): boolean {
    if (!this.owns(userId, id)) return false;

    if (input.name !== undefined || input.description !== undefined) {
      const sets: string[] = [];
      const params: Array<string | null> = [];
      if (input.name !== undefined) {
        sets.push('name = ?');
        params.push(input.name.trim() || 'Untitled');
      }
      if (input.description !== undefined) {
        sets.push('description = ?');
        params.push(input.description);
      }
      this.db.run(`UPDATE playlists SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    }

    if (input.remove?.length) {
      const placeholders = input.remove.map(() => '?').join(',');
      this.db.run(
        `DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id IN (${placeholders})`,
        [id, ...input.remove],
      );
    }
    if (input.add?.length) this.appendSongs(id, input.add);
    if (input.reorder?.length) this.reorder(id, input.reorder);

    this.db.run(`UPDATE playlists SET modified_at = ? WHERE id = ?`, [Date.now(), id]);
    return true;
  }

  remove(userId: string, id: string): boolean {
    // `kind = 'user'` guard: curated playlists are system-managed and never
    // deletable through the per-user API, even by the admin who seeded them.
    const res = this.db.run(
      `DELETE FROM playlists WHERE id = ? AND user_id = ? AND kind = 'user'`,
      [id, userId],
    );
    return Number(res.changes ?? 0) > 0;
  }

  /** True only for a user-owned, mutable playlist — curated rows are read-only. */
  private owns(userId: string, id: string): boolean {
    return Boolean(
      this.db
        .query<
          { id: string },
          [string, string]
        >(`SELECT id FROM playlists WHERE id = ? AND user_id = ? AND kind = 'user'`)
        .get(id, userId),
    );
  }

  /** Append song ids after the current max position, ignoring duplicates. */
  private appendSongs(playlistId: string, songIds: string[]): void {
    const start =
      (this.db
        .query<
          { m: number | null },
          [string]
        >(`SELECT MAX(position) AS m FROM playlist_songs WHERE playlist_id = ?`)
        .get(playlistId)?.m ?? -1) + 1;
    const now = Date.now();
    let pos = start;
    const stmt = this.db.prepare(
      `INSERT INTO playlist_songs (playlist_id, song_id, position, added_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(playlist_id, song_id) DO NOTHING`,
    );
    this.db.transaction(() => {
      for (const songId of songIds) {
        stmt.run(playlistId, songId, pos, now);
        pos += 1;
      }
    })();
  }

  /** Re-number positions to match the given order; ids not listed keep trailing. */
  private reorder(playlistId: string, order: string[]): void {
    const stmt = this.db.prepare(
      `UPDATE playlist_songs SET position = ? WHERE playlist_id = ? AND song_id = ?`,
    );
    this.db.transaction(() => {
      order.forEach((songId, i) => stmt.run(i, playlistId, songId));
    })();
  }

  private summary(r: PlaylistRow, songCount: number): PlaylistSummary {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      songCount,
      coverArt: r.cover_art ?? null,
      kind: r.kind === 'curated' ? 'curated' : 'user',
      createdAt: r.created_at,
      modifiedAt: r.modified_at,
    };
  }
}

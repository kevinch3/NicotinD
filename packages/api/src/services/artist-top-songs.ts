/**
 * An artist's most popular songs, for the artist page's "Popular" block.
 *
 * Two signals, neither complete: `library_songs.popularity` is ListenBrainz's
 * global listen count on a 0–1 log scale and exists only where the file carries
 * a recording MBID; `play_events` is what this server's listeners actually
 * played. A song with neither is not a candidate — the block shows up to
 * `limit` songs that some signal ranks, and none at all rather than a padded
 * list. → docs/popularity.md "Artist page: Popular".
 */
import type { Database } from 'bun:sqlite';
import { recordingKey } from './recording-identity.js';

export const TOP_SONGS_DEFAULT = 5;
export const TOP_SONGS_MAX = 20;

export interface TopSongCandidate {
  id: string;
  /** Same recording on an album, a single and a deluxe edition shares one key. */
  recordingKey: string;
  /** ListenBrainz 0–1, or null when never scored — which is not the same as 0. */
  popularity: number | null;
  /** Counted plays on this server, all listeners. */
  plays: number;
}

/**
 * Every visible song credited to the artist that at least one signal ranks.
 * Membership is the Songs tab's (primary artist or any credit); a hidden song
 * or a hidden album is out, since this block proposes what to play.
 */
export function artistTopSongCandidates(db: Database, artistId: string): TopSongCandidate[] {
  const rows = db
    .query<
      {
        id: string;
        artist_id: string;
        title: string;
        duration: number;
        popularity: number | null;
        plays: number;
      },
      [string, string]
    >(
      `WITH mine AS (
         SELECT s.id FROM library_songs s
          WHERE s.artist_id = ?1
             OR s.id IN (SELECT song_id FROM library_song_artists WHERE artist_id = ?2)
       ),
       played AS (
         SELECT song_id, COUNT(*) AS plays FROM play_events
          WHERE counted = 1 AND song_id IN (SELECT id FROM mine)
          GROUP BY song_id
       )
       SELECT s.id, s.artist_id, s.title, s.duration, s.popularity,
              COALESCE(p.plays, 0) AS plays
         FROM library_songs s
         LEFT JOIN library_albums a ON a.id = s.album_id
         LEFT JOIN played p ON p.song_id = s.id
        WHERE s.id IN (SELECT id FROM mine)
          AND s.hidden = 0
          AND COALESCE(a.hidden, 0) = 0
          AND (s.popularity IS NOT NULL OR p.plays > 0)
        ORDER BY s.id`,
    )
    .all(artistId, artistId);
  return rows.map((r) => ({
    id: r.id,
    // An unidentifiable row (no duration, punctuation-only title) groups with nothing.
    recordingKey: recordingKey(r.artist_id, r.title, r.duration) ?? `song:${r.id}`,
    popularity: r.popularity,
    plays: r.plays,
  }));
}

/**
 * Order the candidates and keep at most `limit` song ids, one per recording.
 *
 * Provider first: a positive ListenBrainz score leads, highest first; locally
 * played songs fill what is left. A score of 0 is "nobody listened", so it
 * ranks nothing on its own. Ties fall to the other signal, then to the id.
 *
 * Pure: the product decision lives here and nowhere else.
 */
export function rankTopSongs(candidates: readonly TopSongCandidate[], limit: number): string[] {
  const score = (c: TopSongCandidate) =>
    c.popularity !== null && c.popularity > 0 ? c.popularity : 0;
  const ranked = candidates
    .filter((c) => score(c) > 0 || c.plays > 0)
    .sort((a, b) => score(b) - score(a) || b.plays - a.plays || (a.id < b.id ? -1 : 1));
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const c of ranked) {
    if (ids.length >= limit) break;
    if (seen.has(c.recordingKey)) continue;
    seen.add(c.recordingKey);
    ids.push(c.id);
  }
  return ids;
}

export function artistTopSongIds(db: Database, artistId: string, limit: number): string[] {
  return rankTopSongs(artistTopSongCandidates(db, artistId), limit);
}

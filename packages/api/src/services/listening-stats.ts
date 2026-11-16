import type { Database } from 'bun:sqlite';
import { unresolvedGenreSql } from './genre-split.js';

/**
 * Aggregates over the listening log — the read side backing the Library "Stats"
 * tab, and the precursor to a year review.
 *
 * Everything here is derived: no schema of its own, no stored rollups. That is
 * deliberate while the log is young — a rollup table would have to be
 * invalidated by the same retention/erasure work that is still open (#454), and
 * the raw table is small enough that SQLite answers these in one pass.
 *
 * Only `counted = 1` rows participate. A night of heavy skipping is not a
 * listening history, and the counting rule already encodes what "listened"
 * means (see play-history.ts).
 *
 * See docs/listening-history.md.
 */

export const STATS_PERIODS = ['30d', 'year', 'all'] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];

/** How many rows each ranked list returns. */
export const TOP_LIMIT = 10;

/** Named genres in the share; the rest fold into `other` (#1670). */
export const GENRE_SHARE_LIMIT = 8;

export interface StatsTotals {
  plays: number;
  distinctSongs: number;
  distinctArtists: number;
  msPlayed: number;
}

/** How many rows a top list may ask for: the default, and what "Show more" reaches (#1669). */
export const TOP_LIMITS = [10, 25, 50] as const;

export interface TopSong {
  songId: string;
  title: string | null;
  artist: string | null;
  plays: number;
  /** The song is still in the library, so it can be played and linked (#1669). */
  live: boolean;
  albumId: string | null;
  artistId: string | null;
  coverArt: string | null;
  coverRev: number;
}

export interface TopArtist {
  artist: string;
  plays: number;
  /** Null for an artist whose songs are no longer in the library: plain text, no link. */
  artistId: string | null;
  /** The portrait, else the cover of the artist's largest album, else null. */
  coverArt: string | null;
  coverRev: number;
  /** Whether `coverArt` is the artist's own portrait or an album cover standing in. */
  coverKind: 'artist' | 'album' | null;
}

export interface TopAlbum {
  album: string;
  artist: string | null;
  plays: number;
  /** Null for an album that is no longer in the library. */
  albumId: string | null;
  artistId: string | null;
  coverArt: string | null;
  coverRev: number;
}

export interface TopGenre {
  genre: string;
  plays: number;
}

export interface GenreShareSlice {
  genre: string;
  plays: number;
  /** `plays / totals.plays`, 0..1. */
  share: number;
}

/**
 * Part-to-whole genre split of the period's plays: each play counts once, under
 * its track's primary genre, so `slices + other + untagged` is exactly
 * `totalPlays` (#1670).
 */
export interface StatsGenreShare {
  totalPlays: number;
  slices: GenreShareSlice[];
  /** Real genres past {@link GENRE_SHARE_LIMIT}. */
  other: { plays: number; share: number; genreCount: number };
  /** No genre, junk vocab (`JUNK_GENRES`), or a deleted song. */
  untagged: { plays: number; share: number };
}

export interface ListeningStats {
  period: StatsPeriod;
  from: number;
  to: number;
  totals: StatsTotals;
  topSongs: TopSong[];
  topArtists: TopArtist[];
  topAlbums: TopAlbum[];
  /** Overlapping per-genre counts (a 3-genre track counts 3 times) — never a share. */
  topGenres: TopGenre[];
  genreShare: StatsGenreShare;
  /** Plays per local hour of day, always 24 buckets so charts never special-case. */
  clock: number[];
}

/**
 * Turn a period name into a window. Pure, so the boundary maths is testable
 * without a clock.
 *
 * `year` means *this calendar year*, not the last 365 days — "my 2026" is the
 * question a year review answers, and a rolling window would quietly mix two
 * years together every January.
 *
 * An unrecognised period falls back to `30d` rather than throwing: this comes
 * straight off a query string, and a stats page that 400s on a typo is worse
 * than one that shows the default.
 */
export function resolvePeriod(period: StatsPeriod, now: number): { from: number; to: number } {
  switch (period) {
    case 'year':
      return { from: Date.UTC(new Date(now).getUTCFullYear(), 0, 1), to: now };
    case 'all':
      return { from: 0, to: now };
    case '30d':
    default:
      return { from: now - 30 * 24 * 3_600_000, to: now };
  }
}

/**
 * `library_songs` carries the live truth, but a deleted song still has history
 * — so every aggregate reads the event's own snapshot as a fallback. This is
 * the payoff for storing it (see the schema comment on `play_events`).
 */
const ARTIST_EXPR = `COALESCE(s.artist, p.artist)`;
const TITLE_EXPR = `COALESCE(s.title, p.title)`;

export function listeningStats(
  db: Database,
  userId: string,
  period: StatsPeriod,
  now: number,
  limit: number = TOP_LIMIT,
): ListeningStats {
  const { from, to } = resolvePeriod(period, now);
  const scope = `p.user_id = ? AND p.counted = 1 AND p.at >= ? AND p.at <= ?`;
  const args: [string, number, number] = [userId, from, to];

  const totals = db
    .query<
      { plays: number; distinct_songs: number; distinct_artists: number; ms_played: number },
      [string, number, number]
    >(
      `SELECT COUNT(*)                          AS plays,
              COUNT(DISTINCT p.song_id)         AS distinct_songs,
              COUNT(DISTINCT ${ARTIST_EXPR})    AS distinct_artists,
              COALESCE(SUM(p.ms_played), 0)     AS ms_played
         FROM play_events p
    LEFT JOIN library_songs s ON s.id = p.song_id
        WHERE ${scope}`,
    )
    .get(...args);

  const topSongs = db
    .query<
      {
        song_id: string;
        title: string | null;
        artist: string | null;
        plays: number;
        live: number;
        album_id: string | null;
        artist_id: string | null;
        cover_art: string | null;
        cover_rev: number | null;
      },
      [string, number, number, number]
    >(
      `SELECT p.song_id            AS song_id,
              ${TITLE_EXPR}        AS title,
              ${ARTIST_EXPR}       AS artist,
              COUNT(*)             AS plays,
              s.id IS NOT NULL     AS live,
              s.album_id           AS album_id,
              s.artist_id          AS artist_id,
              COALESCE(s.cover_art, al.cover_art, s.album_id) AS cover_art,
              al.cover_rev         AS cover_rev
         FROM play_events p
    LEFT JOIN library_songs s  ON s.id = p.song_id
    LEFT JOIN library_albums al ON al.id = s.album_id
        WHERE ${scope}
        GROUP BY p.song_id
        ORDER BY plays DESC, title ASC
        LIMIT ?`,
    )
    .all(...args, limit)
    .map((r) => ({
      songId: r.song_id,
      title: r.title,
      artist: r.artist,
      plays: r.plays,
      live: r.live === 1,
      albumId: r.album_id,
      artistId: r.artist_id,
      coverArt: r.cover_art,
      coverRev: r.cover_rev ?? 0,
    }));

  const topArtists = topArtistsByCredit(db, scope, args, limit);

  // Albums group on the live album row where it exists, falling back to the
  // event's album text — a deleted album still belongs in a year review. The
  // row's id travels with it, so a live album is a link and a deleted one is
  // plain text (#1669). Aliases are deliberately not `artist`/`album`: those
  // names are real columns on the joined tables and SQLite calls the GROUP BY
  // ambiguous.
  const topAlbums = db
    .query<
      {
        album_name: string | null;
        artist_name: string | null;
        plays: number;
        album_id: string | null;
        artist_id: string | null;
        cover_art: string | null;
        cover_rev: number | null;
      },
      [string, number, number, number]
    >(
      `SELECT COALESCE(al.name, p.album) AS album_name,
              COALESCE(al.artist, ${ARTIST_EXPR}) AS artist_name,
              COUNT(*) AS plays,
              al.id AS album_id,
              al.artist_id AS artist_id,
              al.cover_art AS cover_art,
              al.cover_rev AS cover_rev
         FROM play_events p
    LEFT JOIN library_songs s  ON s.id = p.song_id
    LEFT JOIN library_albums al ON al.id = s.album_id
        WHERE ${scope} AND COALESCE(al.name, p.album) IS NOT NULL
        GROUP BY COALESCE(al.id, 'gone:' || album_name || char(0) || COALESCE(artist_name, ''))
        ORDER BY plays DESC, album_name ASC
        LIMIT ?`,
    )
    .all(...args, limit)
    .map((r) => ({
      album: r.album_name ?? '',
      artist: r.artist_name,
      plays: r.plays,
      albumId: r.album_id,
      artistId: r.artist_id,
      coverArt: r.album_id ? (r.cover_art ?? r.album_id) : null,
      coverRev: r.cover_rev ?? 0,
    }));

  // Genres come from the multi-genre join table, not `library_songs.genre` —
  // that column is only the *primary*, so ranking on it would under-report every
  // secondary genre (the same reason filters match the set via EXISTS).
  const topGenres = db
    .query<{ genre: string; plays: number }, [string, number, number, number]>(
      `SELECT g.genre AS genre, COUNT(*) AS plays
         FROM play_events p
         JOIN library_song_genres g ON g.song_id = p.song_id
        WHERE ${scope}
        GROUP BY g.genre
        ORDER BY plays DESC, genre ASC
        LIMIT ?`,
    )
    .all(...args, TOP_LIMIT);

  // The share reads the primary mirror column so a play is counted once; junk
  // vocab is treated as no genre, the same as library health (#1670).
  const genreRows = db
    .query<{ genre: string; plays: number }, [string, number, number]>(
      `SELECT s.genre AS genre, COUNT(*) AS plays
         FROM play_events p
         JOIN library_songs s ON s.id = p.song_id
        WHERE ${scope} AND NOT ${unresolvedGenreSql('s.genre')}
        GROUP BY s.genre
        ORDER BY plays DESC, genre ASC`,
    )
    .all(...args);
  const totalPlays = totals?.plays ?? 0;
  const genreShare = foldGenreShare(genreRows, totalPlays);

  // Local hour, not UTC: "when do I listen" is a wall-clock question, and a
  // server in another timezone would otherwise smear someone's evening.
  const clock = new Array<number>(24).fill(0);
  for (const row of db
    .query<{ at: number }, [string, number, number]>(
      `SELECT p.at AS at FROM play_events p WHERE ${scope}`,
    )
    .all(...args)) {
    const hour = new Date(row.at).getHours();
    if (hour >= 0 && hour < 24) clock[hour] += 1;
  }

  return {
    period,
    from,
    to,
    totals: {
      plays: totals?.plays ?? 0,
      distinctSongs: totals?.distinct_songs ?? 0,
      distinctArtists: totals?.distinct_artists ?? 0,
      msPlayed: totals?.ms_played ?? 0,
    },
    topSongs,
    topArtists,
    topAlbums,
    topGenres,
    genreShare,
    clock,
  };
}

/** Head of {@link GENRE_SHARE_LIMIT} rows, the tail summed into `other`, the remainder untagged. */
function foldGenreShare(
  rows: { genre: string; plays: number }[],
  totalPlays: number,
): StatsGenreShare {
  const share = (plays: number): number => (totalPlays > 0 ? plays / totalPlays : 0);
  const head = rows.slice(0, GENRE_SHARE_LIMIT);
  const tail = rows.slice(GENRE_SHARE_LIMIT);
  const tagged = rows.reduce((sum, r) => sum + r.plays, 0);
  const otherPlays = tail.reduce((sum, r) => sum + r.plays, 0);
  const untaggedPlays = Math.max(0, totalPlays - tagged);
  return {
    totalPlays,
    slices: head.map((r) => ({ genre: r.genre, plays: r.plays, share: share(r.plays) })),
    other: { plays: otherPlays, share: share(otherPlays), genreCount: tail.length },
    untagged: { plays: untaggedPlays, share: share(untaggedPlays) },
  };
}

/**
 * Top artists by **credit** (#1669, owner decision 1): a play counts once toward
 * every artist the song credits, so a featuring appearance counts for both. The
 * credits come from `library_song_artists` (#1526), else the song's own artist;
 * plays of a song that has left the library fall back to the event's artist
 * text and carry no id, so they render as plain text.
 *
 * Three plain joins merged here rather than one query with a correlated
 * "has credits" test per event.
 */
function topArtistsByCredit(
  db: Database,
  scope: string,
  args: [string, number, number],
  limit: number,
): TopArtist[] {
  interface Row {
    artist_id: string | null;
    name: string;
    cover_art: string | null;
    cover_rev: number | null;
    plays: number;
  }
  const credited = db
    .query<Row, [string, number, number]>(
      `SELECT a.id AS artist_id, a.name AS name, a.cover_art AS cover_art,
              a.cover_rev AS cover_rev, COUNT(*) AS plays
         FROM play_events p
         JOIN (SELECT DISTINCT song_id, artist_id FROM library_song_artists) sa
              ON sa.song_id = p.song_id
         JOIN library_artists a ON a.id = sa.artist_id
        WHERE ${scope}
        GROUP BY a.id`,
    )
    .all(...args);
  const uncredited = db
    .query<Row, [string, number, number]>(
      `SELECT a.id AS artist_id, COALESCE(a.name, s.artist) AS name, a.cover_art AS cover_art,
              a.cover_rev AS cover_rev, COUNT(*) AS plays
         FROM play_events p
         JOIN library_songs s ON s.id = p.song_id
    LEFT JOIN library_artists a ON a.id = s.artist_id
        WHERE ${scope}
          AND COALESCE(a.name, s.artist) IS NOT NULL
          AND s.id NOT IN (
            SELECT sa.song_id FROM library_song_artists sa
              JOIN library_artists ca ON ca.id = sa.artist_id
          )
        GROUP BY COALESCE(a.id, 'name:' || s.artist)`,
    )
    .all(...args);
  const gone = db
    .query<Row, [string, number, number]>(
      `SELECT NULL AS artist_id, p.artist AS name, NULL AS cover_art, 0 AS cover_rev,
              COUNT(*) AS plays
         FROM play_events p
    LEFT JOIN library_songs s ON s.id = p.song_id
        WHERE ${scope} AND s.id IS NULL AND p.artist IS NOT NULL
        GROUP BY p.artist`,
    )
    .all(...args);

  // One row per artist: by id where the library has the artist, by name where
  // it does not (a song whose artist row is gone, or a play of a deleted song).
  const merged = new Map<string, Row>();
  for (const r of [...credited, ...uncredited, ...gone]) {
    const key = r.artist_id ?? `name:${r.name}`;
    const seen = merged.get(key);
    if (seen) seen.plays += r.plays;
    else merged.set(key, { ...r });
  }
  const top = [...merged.values()]
    .sort((x, y) => y.plays - x.plays || x.name.localeCompare(y.name))
    .slice(0, limit);

  // Portrait first; an artist without one borrows its largest album's cover.
  const fallback = db.prepare<
    { id: string; cover_art: string | null; cover_rev: number },
    [string]
  >(
    `SELECT id, cover_art, cover_rev FROM library_albums
      WHERE artist_id = ? ORDER BY song_count DESC, name LIMIT 1`,
  );
  return top.map((r) => {
    if (!r.artist_id) {
      return {
        artist: r.name,
        plays: r.plays,
        artistId: null,
        coverArt: null,
        coverRev: 0,
        coverKind: null,
      };
    }
    if (r.cover_art) {
      return {
        artist: r.name,
        plays: r.plays,
        artistId: r.artist_id,
        coverArt: r.cover_art,
        coverRev: r.cover_rev ?? 0,
        coverKind: 'artist' as const,
      };
    }
    const album = fallback.get(r.artist_id);
    return {
      artist: r.name,
      plays: r.plays,
      artistId: r.artist_id,
      coverArt: album ? (album.cover_art ?? album.id) : null,
      coverRev: album?.cover_rev ?? 0,
      coverKind: album ? ('album' as const) : null,
    };
  });
}

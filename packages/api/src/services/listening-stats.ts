import type { Database } from 'bun:sqlite';

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

export interface StatsTotals {
  plays: number;
  distinctSongs: number;
  distinctArtists: number;
  msPlayed: number;
}

export interface TopSong {
  songId: string;
  title: string | null;
  artist: string | null;
  plays: number;
}

export interface TopArtist {
  artist: string;
  plays: number;
}

export interface TopAlbum {
  album: string;
  artist: string | null;
  plays: number;
}

export interface TopGenre {
  genre: string;
  plays: number;
}

export interface ListeningStats {
  period: StatsPeriod;
  from: number;
  to: number;
  totals: StatsTotals;
  topSongs: TopSong[];
  topArtists: TopArtist[];
  topAlbums: TopAlbum[];
  topGenres: TopGenre[];
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
      { song_id: string; title: string | null; artist: string | null; plays: number },
      [string, number, number, number]
    >(
      `SELECT p.song_id            AS song_id,
              ${TITLE_EXPR}        AS title,
              ${ARTIST_EXPR}       AS artist,
              COUNT(*)             AS plays
         FROM play_events p
    LEFT JOIN library_songs s ON s.id = p.song_id
        WHERE ${scope}
        GROUP BY p.song_id
        ORDER BY plays DESC, title ASC
        LIMIT ?`,
    )
    .all(...args, TOP_LIMIT)
    .map((r) => ({ songId: r.song_id, title: r.title, artist: r.artist, plays: r.plays }));

  // Aliases are deliberately not `artist`/`album`: those names also exist as
  // real columns on both joined tables, and SQLite rejects the GROUP BY as
  // ambiguous.
  const topArtists = db
    .query<{ artist_name: string | null; plays: number }, [string, number, number, number]>(
      `SELECT ${ARTIST_EXPR} AS artist_name, COUNT(*) AS plays
         FROM play_events p
    LEFT JOIN library_songs s ON s.id = p.song_id
        WHERE ${scope} AND ${ARTIST_EXPR} IS NOT NULL
        GROUP BY artist_name
        ORDER BY plays DESC, artist_name ASC
        LIMIT ?`,
    )
    .all(...args, TOP_LIMIT)
    .map((r) => ({ artist: r.artist_name ?? '', plays: r.plays }));

  // Albums group on the live album row where it exists, falling back to the
  // event's album text — a deleted album still belongs in a year review.
  const topAlbums = db
    .query<
      { album_name: string | null; artist_name: string | null; plays: number },
      [string, number, number, number]
    >(
      `SELECT COALESCE(al.name, p.album) AS album_name,
              COALESCE(al.artist, ${ARTIST_EXPR}) AS artist_name,
              COUNT(*) AS plays
         FROM play_events p
    LEFT JOIN library_songs s  ON s.id = p.song_id
    LEFT JOIN library_albums al ON al.id = s.album_id
        WHERE ${scope} AND COALESCE(al.name, p.album) IS NOT NULL
        GROUP BY album_name, artist_name
        ORDER BY plays DESC, album_name ASC
        LIMIT ?`,
    )
    .all(...args, TOP_LIMIT)
    .map((r) => ({ album: r.album_name ?? '', artist: r.artist_name, plays: r.plays }));

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
    clock,
  };
}

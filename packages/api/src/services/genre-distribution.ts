/**
 * Genre weight distribution for a scope (artist today; album/library later) —
 * the data behind the radar visualization. See docs/genre-radar.md.
 */
import type { Database } from 'bun:sqlite';

/** Axes beyond this fold into "Other" — a radar past ~8 spokes is unreadable. */
export const MAX_AXES = 8;

export interface GenreSlice {
  genre: string;
  /** Tracks carrying this genre anywhere in their set. */
  count: number;
  /** `count / trackCount`, 0..1. Not a share of a whole — sets overlap. */
  weight: number;
}

export interface GenreDistribution {
  /** Distinct tracks in scope — the denominator. */
  trackCount: number;
  /** Distinct genres before the "Other" fold; lets the UI say what it hid. */
  genreCount: number;
  slices: GenreSlice[];
}

/**
 * Weight = share of the scope's tracks carrying that genre, so a value is
 * readable on its own ("62% of their tracks are Cumbia"). Multi-genre sets
 * overlap, so weights deliberately do **not** sum to 1 — treating them as a
 * part-to-whole would silently under-report every genre on a multi-genre track.
 *
 * Position-blind by choice: a genre counts the same whether it's primary or an
 * extra, matching `genreSetCloseness` (a position-blind MAX over sets), so the
 * chart reflects how genres actually behave in radio scoring rather than a
 * weighting the engine doesn't believe.
 */
export function artistGenreDistribution(db: Database, artistId: string): GenreDistribution {
  const trackCount =
    db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM library_songs
          WHERE (artist_id = ? OR album_artist_id = ?) AND landed_at IS NOT NULL`,
      )
      .get(artistId, artistId)?.n ?? 0;

  if (trackCount === 0) return { trackCount: 0, genreCount: 0, slices: [] };

  const rows = db
    .query<{ genre: string; count: number }, [string, string]>(
      `SELECT sg.genre AS genre, COUNT(DISTINCT s.id) AS count
         FROM library_song_genres sg
         JOIN library_songs s ON s.id = sg.song_id
        WHERE (s.artist_id = ? OR s.album_artist_id = ?) AND s.landed_at IS NOT NULL
        GROUP BY sg.genre
        ORDER BY count DESC, sg.genre ASC`,
    )
    .all(artistId, artistId);

  return {
    trackCount,
    genreCount: rows.length,
    slices: foldTail(rows, trackCount),
  };
}

/**
 * Keep the top {@link MAX_AXES} and fold the rest into one "Other" axis. Its
 * count is the number of tracks carrying *any* folded genre — recomputing that
 * exactly would need a second query, so it's capped at `trackCount` to stay a
 * meaningful share rather than a sum that can exceed the whole.
 */
function foldTail(rows: { genre: string; count: number }[], trackCount: number): GenreSlice[] {
  const head = rows.slice(0, MAX_AXES);
  const tail = rows.slice(MAX_AXES);
  const slices: GenreSlice[] = head.map((r) => ({
    genre: r.genre,
    count: r.count,
    weight: r.count / trackCount,
  }));
  if (tail.length > 0) {
    const count = Math.min(
      trackCount,
      tail.reduce((n, r) => n + r.count, 0),
    );
    slices.push({ genre: 'Other', count, weight: count / trackCount });
  }
  return slices;
}

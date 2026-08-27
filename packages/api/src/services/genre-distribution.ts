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
  return genreDistribution(
    db,
    `(artist_id = ? OR album_artist_id = ?)`,
    [artistId, artistId],
    `(s.artist_id = ? OR s.album_artist_id = ?)`,
    [artistId, artistId],
  );
}

/**
 * Same shape/fold logic as {@link artistGenreDistribution}, scoped to one album
 * instead of everything by an artist — the album-page counterpart the artist
 * radar/strip already has. See docs/genre-radar.md.
 */
export function albumGenreDistribution(db: Database, albumId: string): GenreDistribution {
  return genreDistribution(db, `album_id = ?`, [albumId], `s.album_id = ?`, [albumId]);
}

function genreDistribution(
  db: Database,
  scopeWhere: string,
  scopeParams: string[],
  scopeWhereAliased: string,
  scopeParamsAliased: string[],
): GenreDistribution {
  const trackCount =
    db
      .query<{ n: number }, string[]>(
        `SELECT COUNT(*) AS n FROM library_songs WHERE ${scopeWhere} AND landed_at IS NOT NULL`,
      )
      .get(...scopeParams)?.n ?? 0;

  if (trackCount === 0) return { trackCount: 0, genreCount: 0, slices: [] };

  const rows = db
    .query<{ genre: string; count: number }, string[]>(
      `SELECT sg.genre AS genre, COUNT(DISTINCT s.id) AS count
         FROM library_song_genres sg
         JOIN library_songs s ON s.id = sg.song_id
        WHERE ${scopeWhereAliased} AND s.landed_at IS NOT NULL
        GROUP BY sg.genre
        ORDER BY count DESC, sg.genre ASC`,
    )
    .all(...scopeParamsAliased);

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

/** Chunk size for the batched share query — well under SQLite's variable cap
 *  while keeping a 300-track radio pool to a single round trip in practice. */
const SHARE_CHUNK = 400;

/**
 * Batched counterpart of {@link artistGenreDistribution} for **one** genre set:
 * `artistId → share of that artist's landed tracks carrying any of `genres``.
 *
 * Exists because filter radio needs this figure for every candidate in a
 * 300-track pool, and calling `artistGenreDistribution` per candidate would be
 * 300 multi-query round trips to compute one number each.
 *
 * The match test mirrors `songFilterWheres`' genre clause exactly — primary
 * column OR the join table — so an artist's share can never disagree with the
 * membership test that put their track in the pool. Artists with no landed
 * tracks are simply absent from the map (callers treat that as 0).
 */
export function artistGenreShares(
  db: Database,
  artistIds: readonly string[],
  genres: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>();
  const ids = [...new Set(artistIds.filter(Boolean))];
  if (ids.length === 0 || genres.length === 0) return out;

  const genreMarks = genres.map(() => '?').join(', ');
  const matched = `(s.genre IN (${genreMarks}) OR EXISTS (
      SELECT 1 FROM library_song_genres sg WHERE sg.song_id = s.id AND sg.genre IN (${genreMarks})))`;

  for (let i = 0; i < ids.length; i += SHARE_CHUNK) {
    const chunk = ids.slice(i, i + SHARE_CHUNK);
    const idMarks = chunk.map(() => '?').join(', ');
    const rows = db
      .query<{ artist_id: string; total: number; hits: number }, string[]>(
        `SELECT s.artist_id AS artist_id,
                COUNT(*) AS total,
                SUM(CASE WHEN ${matched} THEN 1 ELSE 0 END) AS hits
           FROM library_songs s
          WHERE s.artist_id IN (${idMarks}) AND s.landed_at IS NOT NULL
          GROUP BY s.artist_id`,
      )
      .all(...genres, ...genres, ...chunk);
    for (const r of rows) {
      if (r.total > 0) out.set(r.artist_id, r.hits / r.total);
    }
  }
  return out;
}

/** One genre and how many songs carry it, for the rare-genre worklist. */
export interface GenreCardinality {
  genre: string;
  songCount: number;
  /** Distinct artists using it — a 1-song genre on 1 artist is the strongest candidate. */
  artistCount: number;
}

/**
 * Genres ordered fewest-songs-first (issue #761).
 *
 * A genre with very few members library-wide is usually a mistag, a scanner
 * mis-split, or an over-specific tag that should fold into a broader one — the
 * same class `library_genre_aliases` / `segmentConcatenatedGenre` already fix
 * for concatenations, but reachable only by *looking* at the distribution.
 * The MCP curator surface had no way to ask: the health report's `genres`
 * dimension counts genre-LESS songs, `list_recent_songs(missingGenre)` filters
 * the same, and `search_library` is text-match. Tallying 16k songs client-side
 * over per-call limits is not a workaround.
 *
 * Worst-first and bounded, matching every other curation worklist so it
 * composes with the same pass.
 *
 * @param maxCount only genres at or below this song count (default: all)
 * @param limit    cap on rows returned
 */
export function rareGenres(
  db: Database,
  opts: { maxCount?: number; limit?: number } = {},
): GenreCardinality[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  // `position = 0` is the primary genre (docs/library-scanner.md). Extras are
  // deliberately excluded: a rare *secondary* tag is normal enrichment noise,
  // whereas a rare PRIMARY is what actually mis-files a song.
  //
  // Hidden artists are excluded so a genre kept alive only by rows the library
  // does not show cannot look populated — the same denominator the rest of the
  // curation surface uses.
  const rows = db
    .query<{ genre: string; songCount: number; artistCount: number }, [number]>(
      `SELECT g.genre AS genre,
              COUNT(DISTINCT g.song_id) AS songCount,
              COUNT(DISTINCT s.artist_id) AS artistCount
         FROM library_song_genres g
         JOIN library_songs s ON s.id = g.song_id
         LEFT JOIN library_artists ar ON ar.id = s.artist_id
        WHERE g.position = 0
          AND TRIM(COALESCE(g.genre, '')) <> ''
          AND COALESCE(ar.hidden, 0) = 0
        GROUP BY g.genre
        ORDER BY songCount ASC, artistCount ASC, g.genre ASC
        LIMIT ?`,
    )
    .all(limit);
  const cap = opts.maxCount;
  return cap === undefined ? rows : rows.filter((r) => r.songCount <= cap);
}

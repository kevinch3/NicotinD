/**
 * Deterministic genre lanes (#1516 P3): genres a genre-less song can be given
 * with no model, from evidence already in the library.
 *
 * - **title**: the title declares its own genres in square brackets,
 *   `Doorways [Downtempo / Folktronica]`.
 * - **siblings**: the artist's other albums agree on one genre.
 *
 * This module only **finds** candidates. Nothing here writes: the predicates
 * have to be tabulated on the real library first, because "siblings agree" has
 * been wrong before (eleven tracks from one rip are one source, not eleven).
 * See docs/genre-lanes.md.
 */
import type { Database } from 'bun:sqlite';
import { genreKey, unresolvedGenreSql } from './genre-split.js';
import { autoGenreVocabulary } from './agent-policy.js';
import { isVariousArtists } from './compilation-tagger.js';
import { isPlaceholderArtistStrict } from './artwork-backfill.js';

export const GENRE_LANES = ['title', 'siblings'] as const;
export type GenreLane = (typeof GENRE_LANES)[number];

export const GENRE_LANE_RULES = {
  /** A title must declare at least this many genres, all known, to count. */
  titleMinGenres: 2,
  /** Other albums by the artist that must each have a dominant genre, and agree. */
  siblingMinAlbums: 2,
  /** Share of an album's tagged songs its dominant genre must hold. */
  siblingAlbumShare: 0.8,
} as const;

export interface GenreLaneCandidate {
  lane: GenreLane;
  songId: string;
  title: string;
  artist: string;
  /** What the lane would write, in the library's spelling, primary first. */
  genres: string[];
  /** Why, in one phrase a person can check. */
  evidence: string;
}

export interface GenreLaneReport {
  /** Songs each lane would tag. A song both lanes reach counts under `title` only. */
  counts: Record<GenreLane, number>;
  /** Distinct artists the sibling lane draws on. */
  siblingArtists: number;
  sample: GenreLaneCandidate[];
}

/**
 * The genres a title declares in square brackets, or null. Every part must be
 * in `vocab`, and there must be at least {@link GENRE_LANE_RULES.titleMinGenres}:
 * one bracketed word (`[Live]`, `[Acoustic]`) is a version, not a genre list.
 */
export function titleDeclaredGenres(
  title: string,
  vocab: ReadonlyMap<string, string>,
): string[] | null {
  for (const m of title.matchAll(/\[([^\]]+)\]/g)) {
    const parts = m[1]!
      .split(/[/|;,]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length < GENRE_LANE_RULES.titleMinGenres) continue;
    const genres = parts.map((p) => vocab.get(genreKey(p)));
    if (genres.some((g) => !g)) continue;
    return [...new Set(genres as string[])];
  }
  return null;
}

/**
 * The one genre an artist's albums agree on, or null. `albums` maps an album to
 * the primary genres of its tagged songs. An album counts when one genre holds
 * {@link GENRE_LANE_RULES.siblingAlbumShare} of them; at least
 * {@link GENRE_LANE_RULES.siblingMinAlbums} albums must count and all agree.
 * Albums, not songs, are the unit: one rip tags every track alike.
 */
export function agreedSiblingGenre(
  albums: ReadonlyMap<string, ReadonlyMap<string, number>>,
  excludeAlbumId: string | null,
): { genreKey: string; albums: number } | null {
  let agreed: string | null = null;
  let counted = 0;
  for (const [albumId, genres] of albums) {
    if (albumId === excludeAlbumId) continue;
    let total = 0;
    let top = '';
    let topN = 0;
    for (const [g, n] of genres) {
      total += n;
      if (n > topN) [top, topN] = [g, n];
    }
    if (!total || topN / total < GENRE_LANE_RULES.siblingAlbumShare) continue;
    if (agreed !== null && agreed !== top) return null;
    agreed = top;
    counted++;
  }
  return agreed !== null && counted >= GENRE_LANE_RULES.siblingMinAlbums
    ? { genreKey: agreed, albums: counted }
    : null;
}

/** Every genre-less song a lane has an answer for. Read-only. */
export function genreLaneCandidates(db: Database): GenreLaneCandidate[] {
  const vocab = autoGenreVocabulary(db);
  const pending = db
    .query<
      { id: string; title: string; artist: string; artist_id: string; album_id: string | null },
      []
    >(
      `SELECT s.id, s.title, s.artist, s.artist_id, s.album_id
         FROM library_songs s
        WHERE ${unresolvedGenreSql('s.genre')}
        ORDER BY s.artist, s.title, s.id`,
    )
    .all();
  if (pending.length === 0) return [];

  // artist → album → primary genre → songs, over every tagged song.
  const byArtist = new Map<string, Map<string, Map<string, number>>>();
  for (const r of db
    .query<{ artist_id: string; album_id: string; genre: string; n: number }, []>(
      `SELECT s.artist_id, s.album_id, s.genre, COUNT(*) AS n
         FROM library_songs s
        WHERE s.album_id IS NOT NULL AND NOT ${unresolvedGenreSql('s.genre')}
        GROUP BY s.artist_id, s.album_id, s.genre`,
    )
    .all()) {
    const k = genreKey(r.genre);
    if (!k) continue;
    let albums = byArtist.get(r.artist_id);
    if (!albums) byArtist.set(r.artist_id, (albums = new Map()));
    let genres = albums.get(r.album_id);
    if (!genres) albums.set(r.album_id, (genres = new Map()));
    genres.set(k, (genres.get(k) ?? 0) + r.n);
  }
  const artistNames = new Map(
    db
      .query<{ id: string; name: string }, []>('SELECT id, name FROM library_artists')
      .all()
      .map((a) => [a.id, a.name]),
  );

  const out: GenreLaneCandidate[] = [];
  for (const s of pending) {
    const declared = titleDeclaredGenres(s.title, vocab);
    if (declared) {
      out.push({
        lane: 'title',
        songId: s.id,
        title: s.title,
        artist: s.artist,
        genres: declared,
        evidence: 'the title lists them in brackets',
      });
      continue;
    }
    const name = artistNames.get(s.artist_id) ?? s.artist;
    if (isVariousArtists(name) || isPlaceholderArtistStrict(name)) continue;
    const albums = byArtist.get(s.artist_id);
    if (!albums) continue;
    const agreed = agreedSiblingGenre(albums, s.album_id);
    const genre = agreed && vocab.get(agreed.genreKey);
    if (!agreed || !genre) continue;
    out.push({
      lane: 'siblings',
      songId: s.id,
      title: s.title,
      artist: s.artist,
      genres: [genre],
      evidence: `${agreed.albums} other albums by ${name} agree`,
    });
  }
  return out;
}

/** Counts per lane and a bounded sample, for the health report. */
export function genreLaneReport(db: Database, sample: number): GenreLaneReport {
  const all = genreLaneCandidates(db);
  const counts: Record<GenreLane, number> = { title: 0, siblings: 0 };
  const artists = new Set<string>();
  for (const c of all) {
    counts[c.lane]++;
    if (c.lane === 'siblings') artists.add(c.artist);
  }
  // Both lanes in the sample, title first: it is the rarer one.
  const titles = all.filter((c) => c.lane === 'title').slice(0, Math.ceil(sample / 2));
  const siblings = all.filter((c) => c.lane === 'siblings').slice(0, sample - titles.length);
  return { counts, siblingArtists: artists.size, sample: [...titles, ...siblings] };
}

/**
 * Definitions for the system-curated, globally-visible playlists (Spotify-style
 * shelves like "Latin Beats" / "2000s Essentials"), plus the pure track-selection
 * used to materialize each into a consumable, ~40-track list.
 *
 * The actual seeding (DB writes) lives in `scripts/seed-curated-playlists.ts`;
 * everything here is pure + unit-tested. Covers are generated separately from
 * `palette` by `scripts/generate-playlist-covers.ts` (see playlist-cover.ts).
 *
 * Each `where` is a SQL fragment over the `library_songs s` alias. The seed
 * runner ANDs in `s.hidden = 0` and `s.year` sanity itself, so defs stay focused
 * on the genre/era/region predicate.
 */
import type { CoverPalette } from './playlist-cover.js';

export interface CuratedPlaylistDef {
  /** Stable slug — cover filename + idempotency key for the seed (by name). */
  slug: string;
  name: string;
  description: string;
  palette: CoverPalette;
  /** SQL WHERE fragment over alias `s` (library_songs). */
  where: string;
  /** Desired length; the list may be shorter if the per-artist cap runs out. */
  targetSize: number;
  /** Max tracks from any one artist, so no single act dominates the list. */
  maxPerArtist: number;
}

/** Argentine acts heavily represented in the library (artist-set playlists). */
const AR_ARTISTS = [
  'Babasónicos',
  'Bersuit Vergarabat',
  'La Renga',
  'Patricio Rey y sus Redonditos de Ricota',
  'Soda Stereo',
  'Andrés Calamaro',
  'Vilma Palma e Vampiros',
  'Juana Molina',
  'Abel Pintos',
  'Diego Torres',
  'Los Fabulosos Cadillacs',
  'Charly García',
  'Gustavo Cerati',
  'Fito Páez',
  'Divididos',
  'Los Auténticos Decadentes',
  'Las Pelotas',
  'Catupecu Machu',
];

const CL_ARTISTS = [
  'Los Tres',
  'Los Bunkers',
  'Mon Laferte',
  'Javiera Mena',
  'Gepe',
  'Ana Tijoux',
  'Inti-Illimani',
  'Victor Jara',
  'Víctor Jara',
  'Los Prisioneros',
  'Chico Trujillo',
  'Los Jaivas',
];

/** SQL `IN (...)` list from a string array (values are single-quoted + escaped). */
function inList(values: string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
}

export const CURATED_PLAYLISTS: CuratedPlaylistDef[] = [
  {
    slug: 'latin-beats',
    name: 'Latin Beats',
    description: 'Hips-don’t-lie energy across Latin pop, cumbia and tropical.',
    palette: { from: '#ff2d73', to: '#ff8a3d' },
    where:
      "(s.genre LIKE '%latin%' OR s.genre LIKE '%cumbia%' OR s.genre LIKE '%salsa%' OR s.genre LIKE '%bachata%' OR s.genre LIKE '%axé%')",
    targetSize: 40,
    maxPerArtist: 2,
  },
  {
    slug: '2000s-essentials',
    name: '2000s Essentials',
    description: 'The defining tracks of the 2000s.',
    palette: { from: '#8e2de2', to: '#f857a6' },
    where: 's.year BETWEEN 2000 AND 2009',
    targetSize: 50,
    maxPerArtist: 2,
  },
  {
    slug: '2010s-beats',
    name: '2010s Beats',
    description: 'Streaming-era hits and big drops.',
    palette: { from: '#6a00f4', to: '#f72585' },
    where: 's.year BETWEEN 2010 AND 2019',
    targetSize: 50,
    maxPerArtist: 2,
  },
  {
    slug: '90s-throwbacks',
    name: '90s Throwbacks',
    description: 'Nostalgia core, straight from the nineties.',
    palette: { from: '#00b4d8', to: '#ff5d8f' },
    where: 's.year BETWEEN 1990 AND 1999',
    targetSize: 40,
    maxPerArtist: 2,
  },
  {
    slug: 'reggae-roots',
    name: 'Reggae Roots',
    description: 'From Marley to Cultura Profética — pure roots.',
    palette: { from: '#1a9e3f', to: '#f5c518' },
    where:
      "(s.genre LIKE '%reggae%' AND s.genre NOT LIKE '%reggaeton%' AND s.genre NOT LIKE '%reggaetón%')",
    targetSize: 40,
    maxPerArtist: 3,
  },
  {
    slug: 'perreo-urbano',
    name: 'Perreo / Urbano',
    description: 'Reggaeton and urbano bangers to move to.',
    palette: { from: '#3a0ca3', to: '#f72585' },
    where: `(s.genre LIKE '%reggaeton%' OR s.genre LIKE '%reggaetón%' OR s.genre LIKE '%urbano%' OR s.artist IN (${inList(
      ['Bad Bunny', 'Wisin & Yandel', 'Calle 13', 'IPAUTA'],
    )}))`,
    targetSize: 40,
    maxPerArtist: 3,
  },
  {
    slug: 'argentinean-hits',
    name: 'Argentinean Hits',
    description: 'Rock nacional and beyond — the Argentine canon.',
    palette: { from: '#4cc9f0', to: '#4361ee' },
    where: `s.artist IN (${inList(AR_ARTISTS)})`,
    targetSize: 50,
    maxPerArtist: 3,
  },
  {
    slug: 'chile-vibes',
    name: 'Chile Vibes',
    description: 'Sounds from the Chilean scene.',
    palette: { from: '#1d3557', to: '#e63946' },
    where: `s.artist IN (${inList(CL_ARTISTS)})`,
    // Only ~3 Chilean acts are in the library (Los Tres, Chico Trujillo, Mon
    // Laferte), so a generous per-artist cap is what makes a full, balanced list.
    targetSize: 30,
    maxPerArtist: 10,
  },
  {
    slug: 'rock-en-espanol',
    name: 'Rock en Español',
    description: 'Rock latino from across the continent.',
    palette: { from: '#2b2d42', to: '#d90429' },
    where:
      "(s.genre LIKE '%rock latino%' OR s.genre LIKE '%rock en espa%' OR s.genre LIKE '%rock nacional%')",
    targetSize: 35,
    maxPerArtist: 2,
  },
  {
    slug: 'electronic-after-dark',
    name: 'Electronic After Dark',
    description: 'Melodic techno, house and late-night electronic.',
    palette: { from: '#0b1d51', to: '#1cb5e0' },
    where:
      "(s.genre LIKE '%electronic%' OR s.genre LIKE '%house%' OR s.genre LIKE '%techno%' OR s.genre LIKE '%nu disco%')",
    targetSize: 40,
    maxPerArtist: 2,
  },
  {
    slug: 'classic-rock-legends',
    name: 'Classic Rock Legends',
    description: 'Prog, psych and the giants of classic rock.',
    palette: { from: '#141e30', to: '#243b55' },
    where:
      "(s.genre LIKE '%progressive rock%' OR s.genre LIKE '%psychedelic%' OR s.genre LIKE '%hard rock%' OR s.genre LIKE '%heavy metal%' OR s.genre LIKE '%classic rock%' OR s.genre LIKE '%blues%')",
    targetSize: 40,
    maxPerArtist: 2,
  },
  {
    slug: 'pop-party',
    name: 'Pop Party',
    description: 'Crossover dance-pop bangers.',
    palette: { from: '#ff5f6d', to: '#ffc371' },
    where: "(s.genre LIKE '%pop%' AND s.genre NOT LIKE '%rock%')",
    targetSize: 40,
    maxPerArtist: 2,
  },
  {
    slug: 'cumbia-y-sol',
    name: 'Cumbia & Sol',
    description: 'Sunday-afternoon tropical and cumbia.',
    palette: { from: '#f7971e', to: '#ffd200' },
    where: "(s.genre LIKE '%cumbia%' OR s.genre LIKE '%tropical%' OR s.genre LIKE '%axé%')",
    targetSize: 30,
    maxPerArtist: 3,
  },
  {
    slug: '2000s-dance-floor',
    name: '2000s Dance Floor',
    description: 'Eiffel 65, Black Eyed Peas and 2000s club energy.',
    palette: { from: '#ee0979', to: '#ff6a00' },
    where:
      "(s.year BETWEEN 2000 AND 2009 AND (s.genre LIKE '%dance%' OR s.genre LIKE '%electronic%' OR s.genre LIKE '%house%' OR s.genre LIKE '%disco%'))",
    targetSize: 40,
    maxPerArtist: 2,
  },
  {
    slug: 'acoustic-folk-calm',
    name: 'Acoustic & Folk Calm',
    description: 'Mellow folk and acoustic to unwind.',
    palette: { from: '#606c38', to: '#a3b18a' },
    where:
      "(s.genre LIKE '%folk%' OR s.genre LIKE '%acoustic%' OR s.genre LIKE '%singer-songwriter%')",
    targetSize: 25,
    maxPerArtist: 3,
  },
];

// ─── Pure track selection ────────────────────────────────────────────

/**
 * Full genre set of `library_songs s` as one '; '-joined string, falling back
 * to the primary column pre-first-rescan. Recipe/curated `where` fragments
 * write plain `s.genre LIKE …`; expandGenreWhere swaps this in so the
 * predicate sees EVERY genre — after the multi-genre split, s.genre alone
 * holds only the primary and would silently drop secondary-genre matches.
 */
export const GENRE_SET_EXPR =
  "COALESCE((SELECT GROUP_CONCAT(sg.genre, '; ') FROM library_song_genres sg WHERE sg.song_id = s.id), s.genre)";

/** Rewrite a recipe `where` fragment to match against the full genre set. */
export function expandGenreWhere(where: string): string {
  return where.replace(/\bs\.genre\b/g, GENRE_SET_EXPR);
}

export interface CandidateRow {
  id: string;
  artist: string;
}

export interface SelectOptions {
  targetSize: number;
  maxPerArtist: number;
  /** Deterministic shuffle seed (default 1) so a re-seed is reproducible. */
  seed?: number;
}

/** Deterministic PRNG (mulberry32) so seeding is reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place-safe Fisher–Yates shuffle of a copy, driven by a seeded PRNG. */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function normalizeArtist(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Pick up to `targetSize` song ids, never more than `maxPerArtist` from any one
 * artist (so the list reads like a curated playlist, not a single act's
 * discography). The candidate order is shuffled deterministically by `seed`, so
 * the same inputs always produce the same list. Returns fewer than `targetSize`
 * when the per-artist cap exhausts the distinct-artist supply — that's intended
 * (a genuinely artist-thin genre yields a shorter, honest list rather than
 * padding one artist).
 */
export function selectCuratedTracks(
  rows: readonly CandidateRow[],
  { targetSize, maxPerArtist, seed = 1 }: SelectOptions,
): string[] {
  const shuffled = seededShuffle(rows, seed);
  const perArtist = new Map<string, number>();
  const picked: string[] = [];
  for (const row of shuffled) {
    if (picked.length >= targetSize) break;
    const key = normalizeArtist(row.artist);
    const count = perArtist.get(key) ?? 0;
    if (count >= maxPerArtist) continue;
    perArtist.set(key, count + 1);
    picked.push(row.id);
  }
  return picked;
}

/**
 * Pure playlist-generation core — recipe definitions, deterministic track
 * ordering (including DJ-style harmonic sequencing), and a seed-set centroid.
 *
 * This module is intentionally DI-free and IO-free so it is directly
 * unit-testable and shared by both curation lanes:
 *   • automated system shelves (recipe → weekly-refreshed `kind='curated'`), and
 *   • the user-driven seed generator (Radio-scored → `kind='user'`).
 *
 * It reuses the existing engines rather than duplicating them:
 *   • `selectCuratedTracks` (seeded shuffle + per-artist cap) from curated-playlists,
 *   • `camelotCompatibility` (Camelot-wheel harmonic scoring) from radio.service,
 *   • `keyToCamelot` from key-detection.
 */
import {
  selectCuratedTracks,
  type CuratedPlaylistDef,
  type CandidateRow,
} from './curated-playlists.js';
import { camelotCompatibility, type SongFeatures } from './radio.service.js';
import { keyToCamelot } from './key-detection.js';

/** How a selected track set is ordered for playback. */
export type PlaylistSort = 'shuffle' | 'bpm' | 'year' | 'newest' | 'harmonic' | 'energy-arc';

/** A self-describing, code-defined recipe for an automated shelf. */
export interface PlaylistRecipe extends CuratedPlaylistDef {
  /** Playback ordering applied after selection. Default 'shuffle'. */
  sort?: PlaylistSort;
  /** 'weekly' → reseed each ISO week; 'static' → stable slug-derived seed. Default 'weekly'. */
  cadence?: 'weekly' | 'static';
}

/**
 * Minimal per-track row the ordering logic needs. A superset of `CandidateRow`
 * plus the enriched fields; the query layer supplies these columns.
 */
export interface OrderableRow extends CandidateRow, SongFeatures {
  /** Epoch ms the track was added to the library (for 'newest'). */
  addedAt?: number;
}

/**
 * Automated-shelf recipes, authored to lean on the enriched metadata (bpm/key/
 * year) the windowed processor fills. Each `where` is a code-defined SQL
 * fragment over alias `s` (`library_songs`) — no user input, injection-safe, the
 * same contract curated defs use. `cadence` defaults to weekly (rotates each ISO
 * week). Lives here (not curated-playlists.ts) so the pure recipe type and its
 * instances stay together without a circular import.
 */
export const RECIPES: PlaylistRecipe[] = [
  {
    slug: 'late-night',
    name: 'Late Night',
    description: 'Low-BPM, slow-burn tracks to wind the night down.',
    palette: { from: '#0b1d51', to: '#6a3093' },
    where: 's.bpm BETWEEN 60 AND 95',
    sort: 'bpm',
    targetSize: 40,
    maxPerArtist: 2,
  },
  {
    slug: 'workout',
    name: 'Workout',
    description: 'High-energy, harmonically-mixed tempo to keep you moving.',
    palette: { from: '#f7971e', to: '#ff2d73' },
    // NULL-tolerant energy refinement: un-analyzed libraries behave exactly as
    // before; once energy is filled, low-energy 130-BPM ballads drop out.
    where: 's.bpm BETWEEN 125 AND 145 AND (s.energy IS NULL OR s.energy >= 0.6)',
    sort: 'harmonic',
    targetSize: 40,
    maxPerArtist: 2,
  },
  {
    slug: 'fresh-this-week',
    name: 'Fresh This Week',
    description: 'The newest additions to the library.',
    palette: { from: '#11998e', to: '#38ef7d' },
    where: '1=1',
    sort: 'newest',
    targetSize: 30,
    maxPerArtist: 2,
  },
  {
    slug: 'harmonic-electronic',
    name: 'Harmonic Electronic',
    description: 'A DJ-style, key-matched electronic set.',
    palette: { from: '#0f0c29', to: '#1cb5e0' },
    where:
      "(s.genre LIKE '%electronic%' OR s.genre LIKE '%house%' OR s.genre LIKE '%techno%') AND s.bpm > 0",
    sort: 'harmonic',
    targetSize: 40,
    maxPerArtist: 2,
  },
  // ---- shelves over the perceptual features (empty until the audio-features /
  // energy enrichment has run; SQL comparisons exclude NULL rows naturally) ----
  {
    slug: 'mellow-acoustic',
    name: 'Mellow Acoustic',
    description: 'Organic, low-energy tracks for a quiet room.',
    palette: { from: '#5d4157', to: '#a8caba' },
    where: 's.acousticness >= 0.6 AND s.energy <= 0.5',
    sort: 'bpm',
    targetSize: 40,
    maxPerArtist: 2,
  },
  {
    slug: 'instrumental-focus',
    name: 'Instrumental Focus',
    description: 'Vocal-free tracks to think to, key-matched for flow.',
    palette: { from: '#141e30', to: '#35577d' },
    where: 's.instrumental >= 0.7',
    sort: 'harmonic',
    targetSize: 40,
    maxPerArtist: 2,
  },
  {
    slug: 'feel-good',
    name: 'Feel Good',
    description: 'Upbeat, danceable tracks riding an energy arc.',
    palette: { from: '#f953c6', to: '#ffcc33' },
    where: 's.valence >= 0.6 AND s.danceability >= 0.55',
    sort: 'energy-arc',
    targetSize: 40,
    maxPerArtist: 2,
  },
  {
    slug: 'late-night-unwind',
    name: 'Late Night Unwind',
    description: 'Low-energy, relaxed moods drifting downward.',
    palette: { from: '#232526', to: '#414345' },
    where: "s.energy <= 0.35 AND (s.mood IN ('relaxed', 'sad') OR s.mood IS NULL)",
    sort: 'energy-arc',
    targetSize: 40,
    maxPerArtist: 2,
  },
];

/** Stable slug → integer seed (matches seed-curated-playlists' scheme). */
export function slugSeed(slug: string): number {
  return slug.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
}

/**
 * ISO-week index since the epoch: `floor(epochDays / 7)`. Used as the shuffle
 * seed for weekly recipes so the set rotates once per week but is fully
 * reproducible/debuggable for any given week.
 */
export function weekSeedFor(now: number): number {
  return Math.floor(now / 86_400_000 / 7);
}

/**
 * Order a track set for playback. `bpm`/`year`/`newest` are plain sorts;
 * `harmonic` greedily chains tracks by Camelot adjacency then nearest BPM (the
 * DJ-mix ordering) — a real payoff of the `key`/`bpm` enrichment. `shuffle`
 * preserves the (already seed-shuffled) input order. Pure; never mutates input.
 */
export function orderTracks<T extends OrderableRow>(rows: readonly T[], sort: PlaylistSort): T[] {
  switch (sort) {
    case 'bpm':
      return [...rows].sort((a, b) => (a.bpm ?? Infinity) - (b.bpm ?? Infinity));
    case 'year':
      return [...rows].sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity));
    case 'newest':
      return [...rows].sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
    case 'harmonic':
      return harmonicChain(rows);
    case 'energy-arc':
      return energyArc(rows);
    case 'shuffle':
    default:
      return [...rows];
  }
}

/**
 * Ramp-up → peak → ramp-down ordering over the `energy` column: sort ascending,
 * then deal alternately onto the front half (ascending) and the back half
 * (later reversed → descending), so the most energetic tracks land mid-set.
 * Tracks without energy sort lowest and therefore sit at the set's edges.
 * Pure; always returns every input row.
 */
function energyArc<T extends OrderableRow>(rows: readonly T[]): T[] {
  const asc = [...rows].sort((a, b) => (a.energy ?? -1) - (b.energy ?? -1));
  const up: T[] = [];
  const down: T[] = [];
  asc.forEach((row, i) => (i % 2 === 0 ? up : down).push(row));
  down.reverse();
  return [...up, ...down];
}

/**
 * Greedy nearest-neighbour chain: start from the first track, then repeatedly
 * pick the remaining track that mixes best — highest Camelot compatibility,
 * tie-broken by closest BPM. Tracks missing key/bpm still get placed (they just
 * score 0 on the harmonic axis), so the result always contains every input.
 */
function harmonicChain<T extends OrderableRow>(rows: readonly T[]): T[] {
  const remaining = [...rows];
  if (remaining.length <= 2) return remaining;

  const ordered: T[] = [remaining.shift() as T];
  while (remaining.length > 0) {
    const prev = ordered[ordered.length - 1];
    const prevCamelot = prev.key ? keyToCamelot(prev.key) : null;
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const compat = camelotCompatibility(prevCamelot, cand.key ? keyToCamelot(cand.key) : null);
      // BPM closeness in [0,1]; only meaningful when both have a tempo.
      const bpmClose =
        prev.bpm && cand.bpm && prev.bpm > 0
          ? Math.max(0, 1 - Math.abs(prev.bpm - cand.bpm) / prev.bpm)
          : 0;
      // Energy closeness in [0,1]; 0-neutral when either side lacks energy so
      // un-analyzed libraries chain exactly as before.
      const energyClose =
        prev.energy !== undefined && cand.energy !== undefined
          ? Math.max(0, 1 - Math.abs(prev.energy - cand.energy))
          : 0;
      const score = compat * 2 + bpmClose + energyClose * 0.5;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }
  return ordered;
}

/**
 * Materialize a recipe against candidate rows into an ordered list of song ids.
 * Weekly recipes use the week seed (rotates weekly, reproducible); static
 * recipes use the slug seed (stable forever). Selection reuses the curated
 * seeded-shuffle + per-artist cap; ordering reuses `orderTracks`.
 */
export function runRecipe(
  recipe: PlaylistRecipe,
  rows: readonly OrderableRow[],
  weekSeed: number,
): string[] {
  const seed = (recipe.cadence ?? 'weekly') === 'weekly' ? weekSeed : slugSeed(recipe.slug);
  const pickedIds = new Set(
    selectCuratedTracks(rows, {
      targetSize: recipe.targetSize,
      maxPerArtist: recipe.maxPerArtist,
      seed,
    }),
  );
  // Keep only the picked rows (preserving selection), then order them.
  const picked = rows.filter((r) => pickedIds.has(r.id));
  return orderTracks(picked, recipe.sort ?? 'shuffle').map((r) => r.id);
}

/**
 * Reduce a set of tracks to a single representative `SongFeatures` "centroid"
 * used to seed generation from an artist or a starred set: mean of the numeric
 * fields (bpm/year/duration) over rows that have them, and the modal (most
 * common) genre/key. `artistId` is left blank so the same-artist penalty stays
 * neutral for a multi-artist seed set. Returns null for an empty set.
 */
export function seedCentroid(rows: readonly OrderableRow[]): SongFeatures | null {
  if (rows.length === 0) return null;
  const mean = (vals: number[]): number | undefined =>
    vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
  const mode = (vals: (string | undefined)[]): string | undefined => {
    const counts = new Map<string, number>();
    for (const v of vals) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best: string | undefined;
    let bestN = 0;
    for (const [v, n] of counts) {
      if (n > bestN) {
        best = v;
        bestN = n;
      }
    }
    return best;
  };
  const meanOf = (pick: (r: OrderableRow) => number | undefined): number | undefined =>
    mean(rows.map(pick).filter((v): v is number => typeof v === 'number'));
  return {
    bpm: meanOf((r) => r.bpm),
    year: meanOf((r) => r.year),
    duration: mean(rows.map((r) => r.duration).filter((v) => v > 0)) ?? 0,
    genre: mode(rows.map((r) => r.genre)),
    key: mode(rows.map((r) => r.key)),
    energy: meanOf((r) => r.energy),
    valence: meanOf((r) => r.valence),
    danceability: meanOf((r) => r.danceability),
    instrumental: meanOf((r) => r.instrumental),
    acousticness: meanOf((r) => r.acousticness),
    artistId: '',
  };
}

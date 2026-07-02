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
export type PlaylistSort = 'shuffle' | 'bpm' | 'year' | 'newest' | 'harmonic';

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
    where: 's.bpm BETWEEN 125 AND 145',
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
    case 'shuffle':
    default:
      return [...rows];
  }
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
      const score = compat * 2 + bpmClose;
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
  return {
    bpm: mean(rows.map((r) => r.bpm).filter((v): v is number => typeof v === 'number')),
    year: mean(rows.map((r) => r.year).filter((v): v is number => typeof v === 'number')),
    duration: mean(rows.map((r) => r.duration).filter((v) => v > 0)) ?? 0,
    genre: mode(rows.map((r) => r.genre)),
    key: mode(rows.map((r) => r.key)),
    artistId: '',
  };
}

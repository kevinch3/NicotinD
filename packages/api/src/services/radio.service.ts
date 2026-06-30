import { keyToCamelot } from './key-detection.js';

export interface SongFeatures {
  bpm?: number;
  key?: string;
  genre?: string;
  duration: number;
  year?: number;
  artistId: string;
}

export interface ScoringWeights {
  genre: number;
  bpm: number;
  key: number;
  year: number;
  duration: number;
  artistPenalty: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  genre: 10,
  bpm: 8,
  key: 6,
  year: 2,
  duration: 1,
  artistPenalty: 8,
};

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function camelotCompatibility(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const numA = parseInt(a, 10);
  const numB = parseInt(b, 10);
  const ringA = a.slice(-1);
  const ringB = b.slice(-1);
  if (isNaN(numA) || isNaN(numB)) return 0;

  if (numA === numB && ringA === ringB) return 1.0;
  // Same number, different ring (A↔B swap) — relative minor/major
  if (numA === numB) return 0.8;
  // Adjacent number on the same ring (wrapping 1↔12)
  if (ringA === ringB) {
    const diff = Math.abs(numA - numB);
    if (diff === 1 || diff === 11) return 0.7;
  }
  return 0;
}

export function scoreSimilarity(
  seed: SongFeatures,
  candidate: SongFeatures,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): number {
  let score = 0;

  // Genre: exact match = full, both present but different = 0
  if (seed.genre && candidate.genre) {
    score += seed.genre === candidate.genre ? weights.genre : 0;
  }

  // BPM proximity: ±5% = near-full score, scaled linearly
  if (seed.bpm && candidate.bpm && seed.bpm > 0) {
    const ratio = Math.abs(seed.bpm - candidate.bpm) / seed.bpm;
    score += clamp01(1 - ratio * 5) * weights.bpm;
  }

  // Harmonic key compatibility via Camelot wheel
  if (seed.key && candidate.key) {
    const seedCamelot = keyToCamelot(seed.key);
    const candCamelot = keyToCamelot(candidate.key);
    score += camelotCompatibility(seedCamelot, candCamelot) * weights.key;
  }

  // Year proximity: ±20 years scaled
  if (seed.year && candidate.year) {
    score += clamp01(1 - Math.abs(seed.year - candidate.year) / 20) * weights.year;
  }

  // Duration similarity: scaled against seed duration
  if (seed.duration > 0 && candidate.duration > 0) {
    const ratio = Math.abs(seed.duration - candidate.duration) / seed.duration;
    score += clamp01(1 - ratio) * weights.duration;
  }

  // Same artist penalty
  if (seed.artistId === candidate.artistId) {
    score -= weights.artistPenalty;
  }

  return score;
}

export interface ScoredSong<T> {
  song: T;
  score: number;
}

export function rankCandidates<T extends SongFeatures>(
  seed: SongFeatures,
  candidates: T[],
  opts: {
    weights?: ScoringWeights;
    maxPerArtist?: number;
    count?: number;
  } = {},
): ScoredSong<T>[] {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const maxPerArtist = opts.maxPerArtist ?? 2;
  const count = opts.count ?? 10;

  const scored = candidates.map((song) => ({
    song,
    score: scoreSimilarity(seed, song, weights),
  }));

  scored.sort((a, b) => b.score - a.score);

  const result: ScoredSong<T>[] = [];
  const artistCounts = new Map<string, number>();

  for (const entry of scored) {
    if (result.length >= count) break;
    const aid = entry.song.artistId;
    const cur = artistCounts.get(aid) ?? 0;
    if (cur >= maxPerArtist) continue;
    artistCounts.set(aid, cur + 1);
    result.push(entry);
  }

  return result;
}

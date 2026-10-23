import type { ApplyMode } from './config.js';
import { UNKNOWN, type Verdict } from './model.js';

export interface Candidate {
  genre: string;
  votes: number;
  high: number;
}

export type Decision =
  | { kind: 'skip'; reason: string }
  | { kind: 'apply'; genre: string; candidates: Candidate[] }
  | { kind: 'propose'; candidates: Candidate[] };

const MAX_CARD_CANDIDATES = 3;

/**
 * Self-consistency over k samples. A quantized model is noisy, so a write
 * needs every sample to name the same genre with high confidence — agreement
 * across samples is the cheap precision gain. Anything short of that, with real
 * votes behind it, becomes a card a human settles; mostly-"unknown" is left
 * alone, per the skill's rule that an inconclusive answer leaves a song untagged
 * rather than queueing noise.
 */
export function decide(verdicts: readonly Verdict[], mode: ApplyMode): Decision {
  if (verdicts.length === 0) return { kind: 'skip', reason: 'no verdicts' };
  const unknown = verdicts.filter((v) => v.genre === UNKNOWN).length;
  if (unknown * 2 >= verdicts.length) {
    return { kind: 'skip', reason: `model answered unknown ${unknown}/${verdicts.length}` };
  }
  const tally = new Map<string, Candidate>();
  for (const v of verdicts) {
    if (v.genre === UNKNOWN) continue;
    const c = tally.get(v.genre) ?? { genre: v.genre, votes: 0, high: 0 };
    c.votes++;
    if (v.confidence === 'high') c.high++;
    tally.set(v.genre, c);
  }
  const candidates = [...tally.values()]
    .sort((a, b) => b.votes - a.votes || b.high - a.high || a.genre.localeCompare(b.genre))
    .slice(0, MAX_CARD_CANDIDATES);
  const top = candidates[0]!;
  const unanimous = top.votes === verdicts.length && top.high === verdicts.length;
  if (unanimous && mode === 'auto') return { kind: 'apply', genre: top.genre, candidates };
  return { kind: 'propose', candidates };
}

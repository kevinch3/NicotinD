import { fold } from '@nicotind/core';

export interface PlayFromSearchCandidate {
  id: string;
  title: string;
  artist: string;
}

/**
 * Ranks the library candidates for an Assistant "play X on NicotinD" query
 * (voice transcriptions are lowercase and unaccented, so everything goes
 * through core's `fold`). Scoring, best first: exact folded title, title
 * prefix, every query token found in title+artist, then the share of tokens
 * found. Returns null when nothing matches any token — the caller keeps
 * current playback rather than jumping to a random track.
 */
export function rankPlayFromSearch<T extends PlayFromSearchCandidate>(
  query: string,
  candidates: readonly T[],
): T | null {
  const q = fold(query).trim();
  if (!q) return null;
  const tokens = q.split(/\s+/).filter(Boolean);
  let best: T | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const title = fold(candidate.title);
    const haystack = `${title} ${fold(candidate.artist)}`;
    let score = 0;
    if (title === q) score = 1000;
    else if (title.startsWith(q)) score = 500;
    else {
      const hits = tokens.filter((t) => haystack.includes(t)).length;
      if (hits === 0) continue;
      score = hits === tokens.length ? 100 + hits : hits;
    }
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

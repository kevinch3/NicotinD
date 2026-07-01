import type { FolderCandidate } from '../services/api/api-types';

export function mergeCandidates(
  base: FolderCandidate[],
  extra: FolderCandidate[],
): FolderCandidate[] {
  const byKey = new Map<string, FolderCandidate>();
  for (const c of [...base, ...extra]) {
    const key = `${c.username}::${c.directory}`;
    const prev = byKey.get(key);
    if (!prev || c.matchPct > prev.matchPct) byKey.set(key, c);
  }
  return [...byKey.values()].sort((a, b) => b.matchPct - a.matchPct);
}

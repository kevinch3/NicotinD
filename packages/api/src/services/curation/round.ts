/**
 * Round assembly (docs/curator-triage.md §3) — pure, so the interesting
 * behaviour is unit-testable without a database.
 *
 * The kind cap is the part that matters: a round of five near-identical cases
 * is data entry, not judgement, and a curator stops opening a surface that
 * feels like data entry. But the cap must never cost a case — when the pool
 * genuinely holds only one kind, the cap relaxes rather than the round
 * shrinking.
 */
import type { CurationCase } from '@nicotind/core';

export const ROUND_SIZE = 5;
export const MAX_PER_KIND = 2;

export function assembleRound(pool: CurationCase[], size = ROUND_SIZE): CurationCase[] {
  const byConfidence = [...pool].sort((a, b) => b.confidence - a.confidence);

  const picked: CurationCase[] = [];
  const perKind = new Map<string, number>();

  // First pass: honour the cap.
  for (const c of byConfidence) {
    if (picked.length >= size) break;
    const used = perKind.get(c.kind) ?? 0;
    if (used >= MAX_PER_KIND) continue;
    picked.push(c);
    perKind.set(c.kind, used + 1);
  }

  // Second pass: the pool did not have enough variety to fill the round, so
  // take the best remaining regardless of kind. A shorter round would be worse
  // than a less varied one.
  if (picked.length < size) {
    const taken = new Set(picked.map((p) => p.id));
    for (const c of byConfidence) {
      if (picked.length >= size) break;
      if (taken.has(c.id)) continue;
      picked.push(c);
      taken.add(c.id);
    }
  }

  return picked;
}

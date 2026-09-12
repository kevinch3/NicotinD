import { describe, it, expect } from 'bun:test';
import { assembleRound, ROUND_SIZE, MAX_PER_KIND } from './round.js';
import type { CurationCase, CurationCaseKind } from '@nicotind/core';

const c = (id: string, kind: CurationCaseKind, confidence = 1): CurationCase => ({
  id,
  kind,
  target: { kind: 'song', id, title: id, subtitle: '' },
  question: 'q',
  evidence: [],
  options: [{ id: 'r', label: 'r', rationale: 'r', effect: { type: 'resolve-only' } }],
  confidence,
  source: 'flag',
});

describe('assembleRound', () => {
  it('returns at most ROUND_SIZE cases', () => {
    const pool = Array.from({ length: 20 }, (_, i) => c(`id${i}`, 'identity'));
    expect(assembleRound(pool)).toHaveLength(ROUND_SIZE);
  });

  it('a short pool is a short round, not an error', () => {
    expect(assembleRound([c('a', 'identity'), c('b', 'listen')])).toHaveLength(2);
  });

  it('an empty pool is an empty round', () => {
    expect(assembleRound([])).toEqual([]);
  });

  it('orders by confidence, highest first', () => {
    const round = assembleRound([
      c('low', 'identity', 0.2),
      c('high', 'listen', 0.9),
      c('mid', 'placement', 0.5),
    ]);
    expect(round.map((r) => r.id)).toEqual(['high', 'mid', 'low']);
  });

  it('caps any one kind at MAX_PER_KIND while other kinds are available', () => {
    const pool = [
      ...Array.from({ length: 5 }, (_, i) => c(`dup${i}`, 'duplicate')),
      c('one', 'identity'),
      c('two', 'listen'),
      c('three', 'placement'),
    ];
    const round = assembleRound(pool);
    const dupes = round.filter((r) => r.kind === 'duplicate');
    expect(dupes.length).toBe(MAX_PER_KIND);
    expect(round).toHaveLength(ROUND_SIZE);
  });

  it('relaxes the cap rather than shrinking the round when only one kind exists', () => {
    const pool = Array.from({ length: 8 }, (_, i) => c(`dup${i}`, 'duplicate'));
    const round = assembleRound(pool);
    expect(round).toHaveLength(ROUND_SIZE);
    expect(round.every((r) => r.kind === 'duplicate')).toBe(true);
  });

  it('never repeats a case within a round', () => {
    const pool = Array.from({ length: 12 }, (_, i) => c(`id${i}`, 'identity'));
    const ids = assembleRound(pool).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

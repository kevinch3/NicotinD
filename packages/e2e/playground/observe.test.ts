import { describe, expect, it } from 'bun:test';
import {
  decodeObservation,
  encodeObservation,
  type Observation,
  sortObservations,
  summarize,
} from './observe';

const obs = (o: Partial<Observation>): Observation => ({
  flow: 'f',
  kind: 'metric',
  title: 't',
  severity: 'info',
  ...o,
});

describe('encode/decode', () => {
  it('round-trips an observation', () => {
    const o = obs({ kind: 'gap', severity: 'high', value: 3, unit: 'count', suggestion: 's' });
    expect(decodeObservation(encodeObservation(o))).toEqual(o);
  });

  it('returns null for non-observation strings', () => {
    expect(decodeObservation('not json')).toBeNull();
    expect(decodeObservation(JSON.stringify({ hello: 'world' }))).toBeNull();
  });

  it('defaults severity when missing', () => {
    const decoded = decodeObservation(JSON.stringify({ flow: 'f', kind: 'metric', title: 't' }));
    expect(decoded?.severity).toBe('info');
  });
});

describe('summarize', () => {
  it('counts by kind, severity, and flow', () => {
    const s = summarize([
      obs({ flow: 'A', kind: 'gap', severity: 'high' }),
      obs({ flow: 'A', kind: 'timing', severity: 'low' }),
      obs({ flow: 'B', kind: 'gap', severity: 'high' }),
    ]);
    expect(s.total).toBe(3);
    expect(s.byKind.gap).toBe(2);
    expect(s.byKind.timing).toBe(1);
    expect(s.bySeverity.high).toBe(2);
    expect(s.flows).toEqual(['A', 'B']);
  });

  it('zero-fills unseen kinds/severities', () => {
    const s = summarize([]);
    expect(s.byKind.metric).toBe(0);
    expect(s.bySeverity.info).toBe(0);
    expect(s.flows).toEqual([]);
  });
});

describe('sortObservations', () => {
  it('orders by severity then kind (errors/gaps first)', () => {
    const sorted = sortObservations([
      obs({ title: 'lo-metric', kind: 'metric', severity: 'low' }),
      obs({ title: 'hi-error', kind: 'error', severity: 'high' }),
      obs({ title: 'hi-metric', kind: 'metric', severity: 'high' }),
      obs({ title: 'hi-gap', kind: 'gap', severity: 'high' }),
    ]);
    expect(sorted.map((o) => o.title)).toEqual(['hi-error', 'hi-gap', 'hi-metric', 'lo-metric']);
  });

  it('does not mutate the input', () => {
    const input = [obs({ severity: 'low' }), obs({ severity: 'high' })];
    const copy = [...input];
    sortObservations(input);
    expect(input).toEqual(copy);
  });
});

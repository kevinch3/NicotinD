import { describe, expect, it } from 'bun:test';
import {
  breadthLines,
  cosinePercentiles,
  neighbourLines,
  pairLines,
  parseArgs,
} from './genre-affinity.js';
import {
  COHERENCE_HIGH,
  MIN_MEMBERS,
  explainGenrePair,
  type GenreCentroid,
} from '../services/genre-affinity.js';

function centroid(
  genre: string,
  vec: number[],
  opts: { members?: number; coherence?: number } = {},
): GenreCentroid {
  const v = new Float32Array(vec);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return {
    genre,
    model: 'm',
    vec: v.map((x) => x / n),
    members: opts.members ?? MIN_MEMBERS,
    coherence: opts.coherence ?? COHERENCE_HIGH,
  };
}

const cs = new Map<string, GenreCentroid>([
  ['tech house', centroid('Tech House', [1, 0.1])],
  ['minimal techno', centroid('Minimal Techno', [1, 0.2])],
  ['electronic', centroid('Electronic', [1, 1], { coherence: 0.5 })],
  ['tango', centroid('Tango', [0, 1])],
  ['thin', centroid('Thin', [0, 1], { members: 1 })],
]);

describe('parseArgs (multi-value flags: --pair A B)', () => {
  it('collects every value up to the next flag, and a bare flag is true', () => {
    expect(parseArgs(['--pair', 'Tech House', 'Tango', '--breadth', '--limit', '5'])).toEqual({
      pair: ['Tech House', 'Tango'],
      breadth: true,
      limit: ['5'],
    });
  });
});

describe('cosinePercentiles (the COS_FLOOR calibration input)', () => {
  it('reports percentiles over usable same-model pairs only', () => {
    const p = cosinePercentiles(cs);
    // 4 usable centroids → 6 pairs; the thin one is excluded.
    expect(p.pairs).toBe(6);
    expect(p.p10).not.toBeNull();
    expect(p.p10!).toBeLessThanOrEqual(p.p50!);
    expect(p.p50!).toBeLessThanOrEqual(p.p90!);
    expect(cosinePercentiles(new Map())).toEqual({ pairs: 0, p10: null, p50: null, p90: null });
  });
});

describe('report lines', () => {
  it('breadthLines ranks the most umbrella-like (lowest coherence) tag first', () => {
    const lines = breadthLines(cs, 10);
    expect(lines[1]).toMatch(/^Electronic/);
    expect(lines.some((l) => l.startsWith('Thin'))).toBe(false);
  });

  it('pairLines names the source and the lexical fallback when a side is unknown', () => {
    const known = pairLines(explainGenrePair('Tech House', 'Minimal Techno', cs)).join('\n');
    expect(known).toContain('(centroid)');
    const unknown = pairLines(explainGenrePair('Tech House', 'Nope', cs)).join('\n');
    expect(unknown).toContain('lexical fallback');
  });

  it('neighbourLines lists neighbours best-first and explains an unknown genre', () => {
    const lines = neighbourLines('Tech House', cs, 10);
    expect(lines[2]).toMatch(/Minimal Techno$/);
    // Self is never its own neighbour (rows start after the two header lines).
    expect(lines.slice(2).filter((l) => /Tech House$/.test(l))).toHaveLength(0);
    expect(neighbourLines('Nope', cs, 10)[0]).toContain('No usable neighbours');
  });
});

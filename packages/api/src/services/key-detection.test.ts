import { describe, expect, it } from 'bun:test';
import { chromaToKey, computeChroma, detectKey, keyToCamelot } from './key-detection.js';

describe('chromaToKey', () => {
  it('identifies C major from a C-E-G weighted chroma', () => {
    // Strong tonic triad C(0) E(4) G(7) → C major.
    const chroma = [1, 0, 0.2, 0, 0.8, 0.1, 0, 0.9, 0, 0.2, 0, 0.1];
    const r = chromaToKey(chroma)!;
    expect(r.key).toBe('C major');
    expect(r.camelot).toBe('8B');
    expect(r.tonic).toBe(0);
    expect(r.mode).toBe('major');
  });

  it('identifies A minor from an A-C-E weighted chroma', () => {
    // A(9) C(0) E(4) triad, minor-leaning → A minor.
    const chroma = [0.8, 0, 0.1, 0.2, 0.75, 0, 0, 0.2, 0, 1, 0, 0.1];
    const r = chromaToKey(chroma)!;
    expect(r.mode).toBe('minor');
    expect(r.key).toBe('A minor');
    expect(r.camelot).toBe('8A');
  });

  it('returns null for an empty/flat chroma', () => {
    expect(chromaToKey(new Array(12).fill(0))).toBeNull();
    expect(chromaToKey([1, 2, 3])).toBeNull(); // wrong length
  });

  it('is transposition-consistent (shifting the chroma shifts the tonic)', () => {
    const cmaj = [1, 0, 0.2, 0, 0.8, 0.1, 0, 0.9, 0, 0.2, 0, 0.1];
    // Rotate up two semitones → D major.
    const dmaj = cmaj.map((_, i) => cmaj[(i - 2 + 12) % 12]!);
    expect(chromaToKey(dmaj)!.key).toBe('D major');
  });
});

describe('keyToCamelot', () => {
  it('maps majors and minors to the Camelot wheel', () => {
    expect(keyToCamelot('C major')).toBe('8B');
    expect(keyToCamelot('A minor')).toBe('8A'); // relative of C major
    expect(keyToCamelot('G major')).toBe('9B');
    expect(keyToCamelot('E minor')).toBe('9A');
    expect(keyToCamelot('F# minor')).toBe('11A');
  });

  it('returns null for an unparseable key', () => {
    expect(keyToCamelot('H flat lydian')).toBeNull();
    expect(keyToCamelot('')).toBeNull();
  });
});

describe('computeChroma + detectKey', () => {
  const sr = 44_100;

  function tone(freq: number, seconds: number): Float32Array {
    const n = Math.floor(sr * seconds);
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = Math.sin((2 * Math.PI * freq * i) / sr);
    return buf;
  }

  it('peaks at the played pitch class (A4 → A)', () => {
    const chroma = computeChroma(tone(440, 3), sr); // A4
    let maxIdx = 0;
    for (let i = 1; i < 12; i++) if (chroma[i]! > chroma[maxIdx]!) maxIdx = i;
    expect(maxIdx).toBe(9); // A
  });

  it('returns a flat chroma for sub-frame input', () => {
    expect(computeChroma(new Float32Array(100), sr).every((v) => v === 0)).toBe(true);
  });

  it('detectKey returns null on silence', () => {
    expect(detectKey(new Float32Array(sr * 6), sr)).toBeNull();
  });
});

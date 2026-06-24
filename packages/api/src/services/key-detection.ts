/**
 * Musical-key detection from decoded PCM — pure DSP, no IO, directly unit-testable.
 *
 * Pipeline: PCM → 12-bin chromagram (pitch-class energy via per-semitone Goertzel
 * filters across a few octaves) → Krumhansl–Schmuckler key estimation (Pearson
 * correlation of the chroma against the 12 rotations of the major and minor
 * key-profile vectors). Returns the best key + its Camelot-wheel code for
 * harmonic mixing / playlist building. Mirrors the BPM approach (decode once,
 * run a self-contained estimator) — heuristic, dependency-free, good enough for
 * library tagging and "same key / adjacent key" playlist heuristics.
 */

const TONIC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

// Krumhansl–Kessler tonal hierarchy profiles (major / minor), tonic at index 0.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Camelot-wheel codes indexed by pitch class (0 = C). B = major ring, A = minor.
const MAJOR_CAMELOT = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const MINOR_CAMELOT = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

export interface KeyResult {
  /** Human key, e.g. "C major" / "A minor". */
  key: string;
  /** Camelot-wheel code, e.g. "8B" / "8A" — adjacent codes are harmonically compatible. */
  camelot: string;
  /** Tonic pitch class (0 = C). */
  tonic: number;
  mode: 'major' | 'minor';
  /** Correlation strength of the winning key (−1..1); higher = more confident. */
  confidence: number;
}

/** Camelot code for a musical key string like "C major" / "A minor", or null. */
export function keyToCamelot(key: string): string | null {
  const m = /^([A-G]#?)\s+(major|minor)$/.exec(key.trim());
  if (!m) return null;
  const tonic = TONIC_NAMES.indexOf(m[1] as (typeof TONIC_NAMES)[number]);
  if (tonic < 0) return null;
  return (m[2] === 'major' ? MAJOR_CAMELOT : MINOR_CAMELOT)[tonic]!;
}

/** Pearson correlation of two equal-length vectors (0 when a vector is flat). */
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/**
 * Pick the best key for a 12-bin chroma vector via Krumhansl–Schmuckler. Returns
 * null when the chroma is empty/flat (no tonal content to correlate).
 */
export function chromaToKey(chroma: number[]): KeyResult | null {
  if (chroma.length !== 12 || chroma.every((v) => v === 0)) return null;
  let best: KeyResult | null = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    // Rotate the profile so its tonic aligns to `tonic` in the chroma.
    const maj = MAJOR_PROFILE.map((_, i) => MAJOR_PROFILE[(i - tonic + 12) % 12]!);
    const min = MINOR_PROFILE.map((_, i) => MINOR_PROFILE[(i - tonic + 12) % 12]!);
    const cMaj = pearson(chroma, maj);
    const cMin = pearson(chroma, min);
    const mode = cMaj >= cMin ? 'major' : 'minor';
    const conf = Math.max(cMaj, cMin);
    if (!best || conf > best.confidence) {
      best = {
        key: `${TONIC_NAMES[tonic]} ${mode}`,
        camelot: (mode === 'major' ? MAJOR_CAMELOT : MINOR_CAMELOT)[tonic]!,
        tonic,
        mode,
        confidence: conf,
      };
    }
  }
  return best;
}

/**
 * Compute a 12-bin chromagram from mono PCM. For each analysis frame, a Goertzel
 * filter measures energy at every semitone across {@link octaves} octaves from C2,
 * folded into 12 pitch classes (0 = C) and accumulated across frames. Pure.
 */
export function computeChroma(
  samples: Float32Array,
  sampleRate: number,
  opts: { frameSize?: number; hop?: number; octaves?: number; lowestMidi?: number } = {},
): number[] {
  const frameSize = opts.frameSize ?? 8192;
  const hop = opts.hop ?? frameSize;
  const octaves = opts.octaves ?? 3;
  const lowestMidi = opts.lowestMidi ?? 48; // C3
  const chroma = new Array<number>(12).fill(0);
  if (samples.length < frameSize) return chroma;

  // Precompute Goertzel coefficients per target semitone.
  const notes: { coeff: number; pc: number }[] = [];
  for (let n = lowestMidi; n < lowestMidi + octaves * 12; n++) {
    const freq = 440 * Math.pow(2, (n - 69) / 12);
    if (freq >= sampleRate / 2) break;
    const omega = (2 * Math.PI * freq) / sampleRate;
    notes.push({ coeff: 2 * Math.cos(omega), pc: ((n % 12) + 12) % 12 });
  }

  // Hann window for the frame.
  const win = new Float32Array(frameSize);
  for (let i = 0; i < frameSize; i++)
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frameSize - 1)));

  for (let start = 0; start + frameSize <= samples.length; start += hop) {
    for (const note of notes) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < frameSize; i++) {
        s0 = win[i]! * samples[start + i]! + note.coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const power = s1 * s1 + s2 * s2 - note.coeff * s1 * s2;
      if (power > 0) chroma[note.pc]! += Math.sqrt(power);
    }
  }

  // Normalize so correlation is scale-invariant.
  const max = Math.max(...chroma);
  if (max > 0) for (let i = 0; i < 12; i++) chroma[i]! /= max;
  return chroma;
}

/** Detect the musical key of mono PCM. Null when there's no tonal content. */
export function detectKey(samples: Float32Array, sampleRate: number): KeyResult | null {
  return chromaToKey(computeChroma(samples, sampleRate));
}

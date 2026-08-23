import { describe, expect, it } from 'bun:test';
import {
  BAND_FRAME_RATE,
  PEAKS_BUCKETS,
  WAVEFORM_VERSION,
  createWaveformReducer,
  downsamplePeaks,
  fftMagnitudes,
} from './waveform-reduce.js';

const SR = 44_100;

function sine(hz: number, seconds: number, amplitude = 1): Float32Array {
  const out = new Float32Array(Math.round(SR * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / SR);
  return out;
}

function reduce(samples: Float32Array, chunk = samples.length) {
  const r = createWaveformReducer(SR);
  for (let i = 0; i < samples.length; i += chunk) r.push(samples.subarray(i, i + chunk));
  return r.finish();
}

/** Index of the band (0..5) carrying the most energy, averaged over all frames. */
function dominantBand(bands: number[][]): number {
  const sums = [0, 0, 0, 0, 0, 0];
  for (const frame of bands) frame.forEach((v, i) => (sums[i] += v));
  return sums.indexOf(Math.max(...sums));
}

describe('fftMagnitudes', () => {
  it('puts a pure tone in the bin matching its frequency', () => {
    const n = 1024;
    const k = 37; // cycles per window → bin 37
    const re = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * k * i) / n);
    const mags = fftMagnitudes(re);
    expect(mags.length).toBe(n / 2);
    const peak = mags.indexOf(Math.max(...mags));
    expect(peak).toBe(k);
  });
});

describe('createWaveformReducer', () => {
  it('describes a 100 Hz tone as bass-dominant and a 5 kHz tone as high-mid-dominant', () => {
    // Band order: sub_bass 20–60, bass 60–250, low_mid 250–500, mid 500–2k,
    // high_mid 2k–6k, high 6k–16k.
    expect(dominantBand(reduce(sine(100, 3)).bands)).toBe(1);
    expect(dominantBand(reduce(sine(5000, 3)).bands)).toBe(4);
  });

  it('scales band levels to 0..1 against the loudest frame-band of the track', () => {
    const { bands } = reduce(sine(100, 3));
    const all = bands.flat();
    expect(Math.max(...all)).toBeCloseTo(1, 2);
    expect(Math.min(...all)).toBeGreaterThanOrEqual(0);
  });

  it('emits band frames at BAND_FRAME_RATE and reports the duration', () => {
    const data = reduce(sine(440, 3));
    expect(data.version).toBe(WAVEFORM_VERSION);
    expect(data.frameRate).toBe(BAND_FRAME_RATE);
    expect(data.duration).toBeCloseTo(3, 2);
    expect(data.bands.length).toBe(3 * BAND_FRAME_RATE);
    expect(data.bands[0]!.length).toBe(6);
  });

  it('peaks follow the signal envelope, interleaved min/max in -1..1', () => {
    const { peaks } = reduce(sine(440, 3, 0.5));
    expect(peaks.length % 2).toBe(0);
    const mins = peaks.filter((_, i) => i % 2 === 0);
    const maxs = peaks.filter((_, i) => i % 2 === 1);
    expect(Math.min(...mins)).toBeCloseTo(-0.5, 2);
    expect(Math.max(...maxs)).toBeCloseTo(0.5, 2);
    expect(Math.max(...mins)).toBeLessThanOrEqual(0);
  });

  it('caps the emitted peaks at PEAKS_BUCKETS for a long track', () => {
    const { peaks } = reduce(sine(440, 60));
    expect(peaks.length).toBe(PEAKS_BUCKETS * 2);
  });

  it('is silence-safe: zeros everywhere, never NaN', () => {
    const data = reduce(new Float32Array(SR * 2));
    expect(data.peaks.every((v) => v === 0)).toBe(true);
    expect(data.bands.flat().every((v) => v === 0)).toBe(true);
  });

  it('gives the same result whether samples arrive in one push or in odd-sized chunks', () => {
    const s = sine(440, 3, 0.7);
    const whole = reduce(s);
    const chunked = reduce(s, 7_777);
    expect(chunked.peaks).toEqual(whole.peaks);
    expect(chunked.bands).toEqual(whole.bands);
    expect(chunked.duration).toBe(whole.duration);
  });
});

describe('downsamplePeaks', () => {
  it('keeps the min of mins and the max of maxes per bucket', () => {
    // 4 pairs → 2 buckets
    const pairs = [-0.1, 0.2, -0.5, 0.1, -0.2, 0.9, -0.3, 0.3];
    expect(downsamplePeaks(pairs, 2)).toEqual([-0.5, 0.2, -0.3, 0.9]);
  });

  it('returns the input unchanged when it already fits', () => {
    const pairs = [-0.1, 0.2, -0.5, 0.1];
    expect(downsamplePeaks(pairs, 10)).toEqual(pairs);
  });
});

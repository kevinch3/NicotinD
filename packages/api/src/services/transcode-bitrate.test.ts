/**
 * Tests for the source-adaptive bitrate ladders.
 *
 * The numbers here are a judgement call, which is the reason the function is
 * pure and table-driven: a judgement call should be arguable in a test rather
 * than buried in an encoder invocation. So these assert the *decisions*, not
 * the arithmetic.
 */
import { describe, expect, it } from 'bun:test';
import { LADDERS, bitrateFor, estimateEncodedBytes } from './transcode-bitrate.js';
import { LIBRARY_FORMATS } from './library-format.js';

const LOSSLESS_OPUS_KBPS = LADDERS.opus.losslessKbps;

describe('bitrateFor — opus', () => {
  it('maps each measured bucket to its agreed rate', () => {
    // The four buckets the real library falls into, 2026-09-20.
    expect(bitrateFor('opus', 64, false)).toBe(64); //    80 files
    expect(bitrateFor('opus', 128, false)).toBe(96); // 8,153 files — the big one
    expect(bitrateFor('opus', 192, false)).toBe(112); // 1,038 files
    expect(bitrateFor('opus', 320, false)).toBe(128); // 4,589 files
  });

  it('is conservative at the top rather than tracking the source up', () => {
    // Opus at 128 is generally transparent for stereo music, so a higher rate
    // from a 320 kbps mp3 would mostly preserve the SOURCE encoder's artifacts.
    expect(bitrateFor('opus', 320, false)).toBe(128);
    expect(bitrateFor('opus', 1411, false)).toBe(128);
  });

  it('gives lossless the top rate without consulting the ladder', () => {
    // A FLAC's bitrate is a property of the material, not a quality choice, so
    // mapping it through buckets meant for lossy sources would be meaningless.
    expect(bitrateFor('opus', 400, true)).toBe(LOSSLESS_OPUS_KBPS);
    expect(bitrateFor('opus', 1411, true)).toBe(LOSSLESS_OPUS_KBPS);
    expect(bitrateFor('opus', null, true)).toBe(LOSSLESS_OPUS_KBPS);
  });

  it('treats an unknown bitrate as top rate, never as a quiet source', () => {
    // The scanner writes 0 when it could not probe one. Reading that as "under
    // 128, so encode at 64" would crush exactly the files we know least about.
    for (const unknown of [null, undefined, 0, NaN, -1]) {
      expect(bitrateFor('opus', unknown, false)).toBe(LOSSLESS_OPUS_KBPS);
    }
  });

  it('puts the boundaries where the buckets say, not one off', () => {
    expect(bitrateFor('opus', 127, false)).toBe(64);
    expect(bitrateFor('opus', 128, false)).toBe(96);
    expect(bitrateFor('opus', 159, false)).toBe(96);
    expect(bitrateFor('opus', 160, false)).toBe(112);
    expect(bitrateFor('opus', 255, false)).toBe(112);
    expect(bitrateFor('opus', 256, false)).toBe(128);
  });

  it('never returns a rate above the source for a lossy file', () => {
    // Spending more bytes than the source carries cannot recover information;
    // it only stores the first encoder's mistakes more faithfully.
    for (const src of [64, 96, 128, 160, 192, 224, 256, 320]) {
      expect(bitrateFor('opus', src, false)).toBeLessThanOrEqual(src);
    }
  });
});

describe('LADDERS', () => {
  // The denominator, asserted rather than assumed: a format that reaches the
  // registry without a calibrated ladder would silently fall back to whatever
  // `LADDERS[format]` happened to be, and the rungs are calibrated to a codec
  // (Opus at 96 ≈ mp3 at 160), so borrowing another format's is not a
  // near-enough default — it is half the rate the target asks for.
  const formats = Object.keys(LIBRARY_FORMATS) as Array<keyof typeof LIBRARY_FORMATS>;

  it('covers every registered library format', () => {
    expect(formats.length).toBeGreaterThan(0);
    for (const f of formats) expect(LADDERS[f]).toBeDefined();
  });

  it.each(formats)('%s is total, so no source falls off the end', (format) => {
    // The catch-all is what lets `bitrateFor` have no default branch, and a
    // default branch is where a silently-wrong rate would hide.
    const steps = LADDERS[format].steps;
    expect(steps[steps.length - 1]!.upTo).toBe(Infinity);
  });

  it.each(formats)('%s ascends in both columns', (format) => {
    // A ladder out of order would still return *a* number, just the wrong one,
    // and nothing else in the module would notice.
    const steps = LADDERS[format].steps;
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!.upTo).toBeGreaterThan(steps[i - 1]!.upTo);
      expect(steps[i]!.targetKbps).toBeGreaterThan(steps[i - 1]!.targetKbps);
    }
  });

  it.each(formats)('%s gives lossless at least its top rung', (format) => {
    // Lossless bypasses the ladder, so nothing else checks that the rate it
    // bypasses to is actually the transparent one.
    const steps = LADDERS[format].steps;
    expect(LADDERS[format].losslessKbps).toBeGreaterThanOrEqual(
      steps[steps.length - 1]!.targetKbps,
    );
  });
});

describe('estimateEncodedBytes', () => {
  it('converts kbps-seconds to bytes decimally', () => {
    // 1 kbps = 1000 bits/s = 125 bytes/s.
    expect(estimateEncodedBytes(60, 96)).toBe(60 * 96 * 125);
  });

  it('returns null for an unknown duration rather than guessing zero', () => {
    // A dry run counts no saving for these. Under-reporting a saving is
    // recoverable; over-reporting one makes an operator size the run wrong.
    for (const d of [null, 0, -1, NaN]) expect(estimateEncodedBytes(d, 96)).toBeNull();
  });

  it('reproduces the measured projection for the biggest bucket', () => {
    // 8,153 files at 96 kbps averaging 4 minutes ≈ 21.8 GiB, the figure the
    // conversion plan sizes the run against.
    const bytes = estimateEncodedBytes(240, 96)! * 8153;
    expect(bytes / 1024 ** 3).toBeCloseTo(21.85, 1);
  });
});

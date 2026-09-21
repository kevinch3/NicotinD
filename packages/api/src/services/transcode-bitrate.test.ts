/**
 * Tests for the source-adaptive Opus bitrate ladder.
 *
 * The numbers here are a judgement call, which is the reason the function is
 * pure and table-driven: a judgement call should be arguable in a test rather
 * than buried in an encoder invocation. So these assert the *decisions*, not
 * the arithmetic.
 */
import { describe, expect, it } from 'bun:test';
import {
  BITRATE_LADDER,
  LOSSLESS_OPUS_KBPS,
  estimateOpusBytes,
  opusBitrateFor,
} from './transcode-bitrate.js';

describe('opusBitrateFor', () => {
  it('maps each measured bucket to its agreed rate', () => {
    // The four buckets the real library falls into, 2026-09-20.
    expect(opusBitrateFor(64, false)).toBe(64); //    80 files
    expect(opusBitrateFor(128, false)).toBe(96); // 8,153 files — the big one
    expect(opusBitrateFor(192, false)).toBe(112); // 1,038 files
    expect(opusBitrateFor(320, false)).toBe(128); // 4,589 files
  });

  it('is conservative at the top rather than tracking the source up', () => {
    // Opus at 128 is generally transparent for stereo music, so a higher rate
    // from a 320 kbps mp3 would mostly preserve the SOURCE encoder's artifacts.
    expect(opusBitrateFor(320, false)).toBe(128);
    expect(opusBitrateFor(1411, false)).toBe(128);
  });

  it('gives lossless the top rate without consulting the ladder', () => {
    // A FLAC's bitrate is a property of the material, not a quality choice, so
    // mapping it through buckets meant for lossy sources would be meaningless.
    expect(opusBitrateFor(400, true)).toBe(LOSSLESS_OPUS_KBPS);
    expect(opusBitrateFor(1411, true)).toBe(LOSSLESS_OPUS_KBPS);
    expect(opusBitrateFor(null, true)).toBe(LOSSLESS_OPUS_KBPS);
  });

  it('treats an unknown bitrate as top rate, never as a quiet source', () => {
    // The scanner writes 0 when it could not probe one. Reading that as "under
    // 128, so encode at 64" would crush exactly the files we know least about.
    for (const unknown of [null, undefined, 0, NaN, -1]) {
      expect(opusBitrateFor(unknown, false)).toBe(LOSSLESS_OPUS_KBPS);
    }
  });

  it('puts the boundaries where the buckets say, not one off', () => {
    expect(opusBitrateFor(127, false)).toBe(64);
    expect(opusBitrateFor(128, false)).toBe(96);
    expect(opusBitrateFor(159, false)).toBe(96);
    expect(opusBitrateFor(160, false)).toBe(112);
    expect(opusBitrateFor(255, false)).toBe(112);
    expect(opusBitrateFor(256, false)).toBe(128);
  });

  it('never returns a rate above the source for a lossy file', () => {
    // Spending more bytes than the source carries cannot recover information;
    // it only stores the first encoder's mistakes more faithfully.
    for (const src of [64, 96, 128, 160, 192, 224, 256, 320]) {
      expect(opusBitrateFor(src, false)).toBeLessThanOrEqual(src);
    }
  });
});

describe('BITRATE_LADDER', () => {
  it('is total, so no source falls off the end', () => {
    // The catch-all is what lets `opusBitrateFor` have no default branch, and
    // a default branch is where a silently-wrong rate would hide.
    expect(BITRATE_LADDER[BITRATE_LADDER.length - 1]!.upTo).toBe(Infinity);
  });

  it('ascends in both columns', () => {
    // A ladder out of order would still return *a* number, just the wrong one,
    // and nothing else in the module would notice.
    for (let i = 1; i < BITRATE_LADDER.length; i++) {
      expect(BITRATE_LADDER[i]!.upTo).toBeGreaterThan(BITRATE_LADDER[i - 1]!.upTo);
      expect(BITRATE_LADDER[i]!.opusKbps).toBeGreaterThan(BITRATE_LADDER[i - 1]!.opusKbps);
    }
  });
});

describe('estimateOpusBytes', () => {
  it('converts kbps-seconds to bytes decimally', () => {
    // 1 kbps = 1000 bits/s = 125 bytes/s.
    expect(estimateOpusBytes(60, 96)).toBe(60 * 96 * 125);
  });

  it('returns null for an unknown duration rather than guessing zero', () => {
    // A dry run counts no saving for these. Under-reporting a saving is
    // recoverable; over-reporting one makes an operator size the run wrong.
    for (const d of [null, 0, -1, NaN]) expect(estimateOpusBytes(d, 96)).toBeNull();
  });

  it('reproduces the measured projection for the biggest bucket', () => {
    // 8,153 files at 96 kbps averaging 4 minutes ≈ 21.8 GiB, the figure the
    // conversion plan sizes the run against.
    const bytes = estimateOpusBytes(240, 96)! * 8153;
    expect(bytes / 1024 ** 3).toBeCloseTo(21.85, 1);
  });
});

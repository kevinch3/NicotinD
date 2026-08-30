import { describe, expect, test } from 'bun:test';
import { resolveTranscodeLossless } from './transcode-settings.js';

describe('resolveTranscodeLossless', () => {
  test('an offline script with no config file gets the shipped default, not a disabled one', () => {
    // The bug: every backfill entry point invented its own fallback
    // (`{enabled:false, bitRate:128}`), so `reorganize-library.ts` organized the
    // library without ever transcoding, and the Admin task wrote 128k next to
    // the download path's 192k.
    expect(resolveTranscodeLossless(undefined)).toEqual({ enabled: true, bitRate: 192 });
  });

  test('reads an explicit bitRate from the config file', () => {
    expect(
      resolveTranscodeLossless({ downloads: { transcodeLossless: { bitRate: 256 } } }),
    ).toEqual({ enabled: true, bitRate: 256 });
  });

  test('honours an explicit opt-out', () => {
    expect(
      resolveTranscodeLossless({ downloads: { transcodeLossless: { enabled: false } } }),
    ).toEqual({ enabled: false, bitRate: 192 });
  });

  test('a partial downloads block still gets the transcode default', () => {
    expect(resolveTranscodeLossless({ downloads: { autoAcquireEnabled: true } })).toEqual({
      enabled: true,
      bitRate: 192,
    });
  });

  test('an out-of-range bitRate falls back to the default rather than encoding at it', () => {
    // The schema caps bitRate at 320; a typo'd 3200 must not reach ffmpeg.
    expect(
      resolveTranscodeLossless({ downloads: { transcodeLossless: { bitRate: 3200 } } }),
    ).toEqual({ enabled: true, bitRate: 192 });
  });
});

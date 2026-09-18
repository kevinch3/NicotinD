import { describe, expect, it } from 'vitest';
import {
  FALLBACK_EPOCH_SECONDS,
  pinManifestTimestamp,
  resolveBrowserOutputDir,
  resolveSourceDateEpoch,
} from './pin-ngsw-timestamp';

const never = (): number | null => {
  throw new Error('git should not have been consulted');
};

describe('resolveSourceDateEpoch', () => {
  it('prefers SOURCE_DATE_EPOCH — the value F-Droid sets', () => {
    expect(resolveSourceDateEpoch({ SOURCE_DATE_EPOCH: '1789752050' }, never)).toEqual({
      seconds: 1789752050,
      source: 'SOURCE_DATE_EPOCH',
    });
  });

  it('falls back to the HEAD commit time, matching how fdroidserver derives it', () => {
    expect(resolveSourceDateEpoch({}, () => 1789752050)).toEqual({
      seconds: 1789752050,
      source: 'git',
    });
  });

  it('falls back to the zip epoch where git cannot answer (Docker has no .git)', () => {
    expect(resolveSourceDateEpoch({}, () => null)).toEqual({
      seconds: FALLBACK_EPOCH_SECONDS,
      source: 'fallback',
    });
  });

  it('treats an empty SOURCE_DATE_EPOCH as unset', () => {
    expect(resolveSourceDateEpoch({ SOURCE_DATE_EPOCH: '' }, () => 42).source).toBe('git');
  });

  it.each(['not-a-number', '12.5', '-1', ' 17 abc'])(
    'throws on a malformed SOURCE_DATE_EPOCH (%s) rather than silently unpinning',
    (raw) => {
      expect(() => resolveSourceDateEpoch({ SOURCE_DATE_EPOCH: raw }, never)).toThrow(
        /non-negative integer/,
      );
    },
  );
});

describe('pinManifestTimestamp', () => {
  const manifest = (ts: number): string =>
    `{\n  "configVersion": 1,\n  "timestamp": ${ts},\n  "index": "/index.html"\n}\n`;

  it('rewrites the timestamp in milliseconds', () => {
    expect(pinManifestTimestamp(manifest(1789730976714), 1789752050)).toContain(
      '"timestamp": 1789752050000',
    );
  });

  it('changes nothing else, byte for byte', () => {
    const before = manifest(1789730976714);
    const after = pinManifestTimestamp(before, 1789752050);
    expect(after.replace('1789752050000', 'X')).toBe(before.replace('1789730976714', 'X'));
  });

  it('is idempotent — two builds of one commit produce one file', () => {
    const once = pinManifestTimestamp(manifest(1789730976714), 1789752050);
    expect(pinManifestTimestamp(once, 1789752050)).toBe(once);
  });

  it('tolerates whitespace variants of the field', () => {
    expect(pinManifestTimestamp('{"timestamp":123}', 1)).toBe('{"timestamp":1000}');
  });

  // The failure that matters: Angular changes the manifest shape, the pin stops
  // matching, and the build keeps succeeding while reproducibility goes away.
  it('throws when the field is absent', () => {
    expect(() => pinManifestTimestamp('{"configVersion": 1}', 1)).toThrow(/found 0/);
  });

  it('throws when the field appears more than once', () => {
    expect(() => pinManifestTimestamp('{"timestamp": 1, "a": {"timestamp": 2}}', 1)).toThrow(
      /found 2/,
    );
  });
});

describe('resolveBrowserOutputDir', () => {
  it('reads the object form Angular 17+ writes', () => {
    expect(resolveBrowserOutputDir({ base: 'dist', browser: '' }, '/web')).toBe('/web/dist');
  });

  it('defaults the browser sub-directory when only base is given', () => {
    expect(resolveBrowserOutputDir({ base: 'dist' }, '/web')).toBe('/web/dist/browser');
  });

  it('still accepts the legacy string form', () => {
    expect(resolveBrowserOutputDir('dist/browser', '/web')).toBe('/web/dist/browser');
  });

  it('throws on a shape it does not understand', () => {
    expect(() => resolveBrowserOutputDir(undefined, '/web')).toThrow(/outputPath/);
  });
});

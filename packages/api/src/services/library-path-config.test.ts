import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NicotinDConfigSchema } from '@nicotind/core';
import { LibraryOrganizer } from './library-organizer.js';
import { DEFAULT_UNSORTED_DIR } from './library-paths.js';

describe('downloads.dir config', () => {
  const base = { jwt: { secret: 'x'.repeat(32) }, musicDir: '/music' };

  test('defaults to the reserved staging dir', () => {
    const c = NicotinDConfigSchema.parse(base);
    expect(c.downloads.dir).toBe('.downloads');
  });

  test('rejects a nested relative dir — only a top-level name can be reserved', () => {
    // isReservedTopLevel matches a single segment, so `a/b` would be written to
    // but never skipped: #827 again under a new name.
    expect(() => NicotinDConfigSchema.parse({ ...base, downloads: { dir: 'staging/tmp' } })).toThrow();
  });

  test('accepts an absolute dir (its own disk, outside musicDir)', () => {
    const c = NicotinDConfigSchema.parse({ ...base, downloads: { dir: '/mnt/fast/staging' } });
    expect(c.downloads.dir).toBe('/mnt/fast/staging');
  });
});

describe('LibraryOrganizer unsortedRoot default', () => {
  test('defaults to a reserved dir, so an un-overridden deployment is safe', () => {
    // Was 'Unsorted' — a plain relative dir inside musicDir that the scanner
    // walked. Production only escaped it by overriding at two call sites.
    const musicDir = mkdtempSync(join(tmpdir(), 'unsorted-default-'));
    try {
      const org = new LibraryOrganizer({
        musicDir,
        transcodeLossless: { enabled: false, bitRate: 192 },
      });
      expect((org as unknown as { unsortedRoot: string }).unsortedRoot).toBe(DEFAULT_UNSORTED_DIR);
    } finally {
      rmSync(musicDir, { recursive: true, force: true });
    }
  });
});

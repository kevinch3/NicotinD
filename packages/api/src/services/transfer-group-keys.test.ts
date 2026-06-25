import { describe, expect, it } from 'bun:test';
import { transferGroupKeys, isInFlight } from './transfer-group-keys.js';
import { albumGroupKey } from './album-grouping.js';
import type { SlskdUserTransferGroup, SlskdTransferState } from '@nicotind/core';

function file(filename: string, state: SlskdTransferState) {
  return {
    id: filename,
    username: 'peer',
    filename,
    size: 1,
    state,
    bytesTransferred: 0,
    averageSpeed: 0,
    percentComplete: 0,
  };
}

function groups(
  dirs: Array<{ directory: string; files: ReturnType<typeof file>[] }>,
): SlskdUserTransferGroup[] {
  return [
    { username: 'peer', directories: dirs.map((d) => ({ ...d, fileCount: d.files.length })) },
  ];
}

describe('transferGroupKeys', () => {
  it('keys an in-flight transfer by edition-collapsed artist+album from the directory', () => {
    const keys = transferGroupKeys(
      groups([
        {
          directory: 'Lana Del Rey\\Ultraviolence (JP Deluxe Edition)',
          files: [file('01 - Cruel World.flac', 'InProgress')],
        },
      ]),
    );
    // Deluxe/edition qualifiers collapse, so this matches the base album card.
    expect(keys.has(albumGroupKey('Lana Del Rey', 'Ultraviolence'))).toBe(true);
    expect(keys.size).toBe(1);
  });

  it('ignores directories whose files are all finished/failed', () => {
    const keys = transferGroupKeys(
      groups([
        {
          directory: 'Artist\\Done Album',
          files: [file('01 - a.flac', 'Completed, Succeeded')],
        },
        {
          directory: 'Artist\\Failed Album',
          files: [file('01 - b.flac', 'Completed, Errored')],
        },
      ]),
    );
    expect(keys.size).toBe(0);
  });

  it('counts a directory as in-flight if ANY file is still transferring', () => {
    const keys = transferGroupKeys(
      groups([
        {
          directory: 'Artist\\Mixed Album',
          files: [
            file('01 - a.flac', 'Completed, Succeeded'),
            file('02 - b.flac', 'Queued, Remotely'),
          ],
        },
      ]),
    );
    expect(keys.has(albumGroupKey('Artist', 'Mixed Album'))).toBe(true);
  });

  it('falls back to the file path when the directory is a single segment', () => {
    const keys = transferGroupKeys(
      groups([
        {
          directory: 'Just An Album Folder',
          files: [file('Some Artist\\Just An Album Folder\\01 - x.flac', 'Initializing')],
        },
      ]),
    );
    expect(keys.has(albumGroupKey('Some Artist', 'Just An Album Folder'))).toBe(true);
  });

  it('skips when artist/album cannot be parsed', () => {
    const keys = transferGroupKeys(
      groups([{ directory: 'loose-file', files: [file('loose-file.flac', 'InProgress')] }]),
    );
    expect(keys.size).toBe(0);
  });

  it('returns empty for null/undefined groups (fast path)', () => {
    expect(transferGroupKeys(null).size).toBe(0);
    expect(transferGroupKeys(undefined).size).toBe(0);
    expect(transferGroupKeys([]).size).toBe(0);
  });

  it('isInFlight matches only pre-completion states', () => {
    expect(isInFlight('InProgress')).toBe(true);
    expect(isInFlight('Queued, Locally')).toBe(true);
    expect(isInFlight('Completed, Succeeded')).toBe(false);
    expect(isInFlight('Completed, Cancelled')).toBe(false);
  });
});

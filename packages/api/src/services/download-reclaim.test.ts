import { describe, expect, it } from 'bun:test';
import {
  indexLibrary,
  judgeStrandedFile,
  titleFromFilename,
  titleKey,
  type LibraryTrack,
} from './download-reclaim.js';

const onDisk = () => true;
const missing = () => false;

function lib(...tracks: LibraryTrack[]) {
  return indexLibrary(tracks);
}

describe('titleFromFilename', () => {
  it('takes the title out of both shapes the backlog actually uses', () => {
    expect(titleFromFilename('07 Ramble On.flac')).toBe('Ramble On');
    expect(titleFromFilename('Led Zeppelin - Led Zeppelin II - 07 - Ramble On.flac')).toBe(
      'Ramble On',
    );
  });

  it('keeps a title that itself contains a dash', () => {
    expect(titleFromFilename('01 Sgt. Pepper - Reprise.flac')).toBe('Reprise');
  });

  it('survives a filename that is only a track number', () => {
    expect(titleFromFilename('07.flac')).toBe('');
  });
});

describe('titleKey', () => {
  it('folds accents so a peer’s unaccented spelling still matches', () => {
    expect(titleKey('Una vez más')).toBe(titleKey('Una vez mas'));
  });

  it('ignores punctuation and case', () => {
    expect(titleKey("Don't Stop!")).toBe(titleKey('dont stop'));
  });
});

describe('judgeStrandedFile', () => {
  const track: LibraryTrack = {
    title: 'Ramble On',
    duration: 274,
    path: 'Zep/II/07 Ramble On.opus',
  };

  it('proves a file whose title and duration both match a library track on disk', () => {
    const v = judgeStrandedFile('07 Ramble On.flac', 274, lib(track), onDisk);
    expect(v.kind).toBe('proven');
  });

  it('accepts a small transcode drift', () => {
    expect(judgeStrandedFile('07 Ramble On.flac', 275.4, lib(track), onDisk).kind).toBe('proven');
  });

  /**
   * The real false positive from the 60-file prod sample: "Una vez más" on disk
   * runs 235 s while every same-titled library row is a different length. Title
   * matching alone would have deleted a recording the library does not hold.
   */
  it('refuses a same-title track of a different length', () => {
    const library = lib(
      { title: 'Una vez más', duration: 180, path: 'a.opus' },
      { title: 'Una vez más', duration: 255, path: 'b.opus' },
      { title: 'Una vez más', duration: 175, path: 'c.opus' },
      { title: 'Una vez más', duration: 241, path: 'd.opus' },
    );
    const v = judgeStrandedFile('12 Una vez más.flac', 235, library, onDisk);
    expect(v.kind).toBe('duration-mismatch');
    if (v.kind === 'duration-mismatch') expect(v.libraryDurations).toHaveLength(4);
  });

  it('refuses when the library row points at a file that is gone', () => {
    expect(judgeStrandedFile('07 Ramble On.flac', 274, lib(track), missing).kind).toBe(
      'library-file-missing',
    );
  });

  it('refuses a title the library does not have', () => {
    expect(judgeStrandedFile('07 Unknown Song.flac', 274, lib(track), onDisk).kind).toBe(
      'no-title-match',
    );
  });

  it('refuses when the duration could not be read', () => {
    expect(judgeStrandedFile('07 Ramble On.flac', null, lib(track), onDisk).kind).toBe(
      'unreadable',
    );
    expect(judgeStrandedFile('07 Ramble On.flac', 0, lib(track), onDisk).kind).toBe('unreadable');
  });

  /** A one- or two-character key would match a large slice of any library. */
  it('refuses a title too short to identify anything', () => {
    const library = lib({ title: 'A', duration: 274, path: 'a.opus' });
    expect(judgeStrandedFile('07 A.flac', 274, library, onDisk).kind).toBe('no-title-match');
  });

  it('picks the same-length candidate that is actually on disk', () => {
    const library = lib(
      { title: 'Ramble On', duration: 274, path: 'gone.opus' },
      { title: 'Ramble On', duration: 274, path: 'kept.opus' },
    );
    const v = judgeStrandedFile('07 Ramble On.flac', 274, library, (p) => p === 'kept.opus');
    expect(v.kind).toBe('proven');
    if (v.kind === 'proven') expect(v.matched.path).toBe('kept.opus');
  });
});

import { describe, it, expect } from 'bun:test';
import { recordingKey } from './recording-identity.js';

const ARTIST = 'artist-abc';
const OTHER = 'artist-xyz';

describe('recordingKey', () => {
  it('gives the same key to two files of one recording', () => {
    // The prod case: the album copy and the compilation copy, same master.
    const album = recordingKey(ARTIST, 'Seguir viviendo sin tu amor', 161);
    const compilation = recordingKey(ARTIST, 'Seguir viviendo sin tu amor', 161);
    expect(album).toBe(compilation!);
    expect(album).not.toBeNull();
  });

  it('folds diacritics, case and punctuation', () => {
    const accented = recordingKey(ARTIST, 'Canción', 200);
    expect(recordingKey(ARTIST, 'cancion', 200)).toBe(accented!);
    expect(recordingKey(ARTIST, 'CANCIÓN!', 200)).toBe(accented!);
  });

  it('collapses whitespace differences', () => {
    expect(recordingKey(ARTIST, '  Spaced   Out  ', 200)).toBe(
      recordingKey(ARTIST, 'Spaced Out', 200)!,
    );
  });

  it('keeps a live cut distinct from the studio take', () => {
    expect(recordingKey(ARTIST, 'Song (Live)', 200)).not.toBe(recordingKey(ARTIST, 'Song', 200)!);
  });

  it('keeps different durations distinct — that is what makes the tuple safe', () => {
    // A remix or a re-recording shares title + artist and differs in length.
    expect(recordingKey(ARTIST, 'Song', 200)).not.toBe(recordingKey(ARTIST, 'Song', 214)!);
  });

  it('keeps the same title under a different artist distinct', () => {
    expect(recordingKey(ARTIST, 'Song', 200)).not.toBe(recordingKey(OTHER, 'Song', 200)!);
  });

  it('is null when the duration is missing — library_songs.duration defaults to 0', () => {
    expect(recordingKey(ARTIST, 'Song', 0)).toBeNull();
    expect(recordingKey(ARTIST, 'Song', -1)).toBeNull();
  });

  it('is null when the title normalizes away', () => {
    // `normalizeTitle` strips everything outside ASCII \w\s, so a CJK-only
    // title reduces to "". Without this guard every such track by one artist
    // at one duration would collapse into a single recording.
    expect(recordingKey(ARTIST, '日本語', 200)).toBeNull();
    expect(recordingKey(ARTIST, '   ', 200)).toBeNull();
    expect(recordingKey(ARTIST, '', 200)).toBeNull();
  });

  it('never groups two unidentifiable rows together', () => {
    // Two nulls must not compare equal — ambiguity is left to dangle, never
    // guessed (the discipline `repointPlaylistsBeforePrune` encodes).
    const a = recordingKey(ARTIST, '日本語', 200);
    const b = recordingKey(ARTIST, '한국어', 200);
    expect(a).toBeNull();
    expect(b).toBeNull();
  });

  it('is null when the artist id is empty', () => {
    expect(recordingKey('', 'Song', 200)).toBeNull();
  });
});

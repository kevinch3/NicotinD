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
    // A title made only of punctuation carries no identity. This guard used to
    // fire for CJK titles too, because `normalizeTitle` was ASCII-only — see
    // the non-Latin test below, which is now the opposite assertion.
    expect(recordingKey(ARTIST, '...', 200)).toBeNull();
    expect(recordingKey(ARTIST, '!!! ???', 200)).toBeNull();
    expect(recordingKey(ARTIST, '   ', 200)).toBeNull();
    expect(recordingKey(ARTIST, '', 200)).toBeNull();
  });

  it('never groups two unidentifiable rows together', () => {
    // Two nulls must not compare equal — ambiguity is left to dangle, never
    // guessed (the discipline `repointPlaylistsBeforePrune` encodes).
    expect(recordingKey(ARTIST, '...', 200)).toBeNull();
    expect(recordingKey(ARTIST, '---', 200)).toBeNull();
  });

  it('gives a non-Latin title a real, distinct key', () => {
    // `normalizeTitle` was ASCII-only, so every CJK/Hangul/Cyrillic title
    // reduced to "" and was excluded from recording identity altogether —
    // those tracks could never be deduped. Now they key like any other.
    const a = recordingKey(ARTIST, '日本語', 200);
    const b = recordingKey(ARTIST, '한국어', 200);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b!);
  });

  it('groups the album and compilation copies of one non-Latin track', () => {
    // The point of the key: two files of one recording collapse to one.
    expect(recordingKey(ARTIST, 'Группа крови', 245)).toBe(
      recordingKey(ARTIST, 'Группа крови', 245)!,
    );
  });

  it('is null when the artist id is empty', () => {
    expect(recordingKey('', 'Song', 200)).toBeNull();
  });
});

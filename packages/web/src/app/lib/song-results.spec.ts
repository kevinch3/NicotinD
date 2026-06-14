import {
  compareVersions,
  formatBadge,
  groupBySong,
  songKey,
  songTitle,
  type SongVersion,
} from './song-results';

const v = (o: Partial<SongVersion>): SongVersion => ({
  username: 'peer',
  filename: 'Toxic.mp3',
  size: 1000,
  ...o,
});

describe('songTitle', () => {
  it('prefers the tag title', () => {
    expect(songTitle(v({ title: 'Toxic', filename: 'x\\03 - whatever.flac' }))).toBe('Toxic');
  });

  it('falls back to the filename stem without track number or extension', () => {
    expect(songTitle(v({ filename: 'Britney Spears\\03 - Toxic.flac' }))).toBe('Toxic');
    expect(songTitle(v({ filename: '07_Closing_Time.mp3' }))).toBe('Closing_Time');
  });
});

describe('songKey', () => {
  it('scopes the title by artist and is punctuation/case-insensitive', () => {
    expect(songKey('Britney Spears', 'Toxic!')).toBe(songKey('britney  spears', 'toxic'));
  });

  it('keys on title alone when artist is unknown', () => {
    expect(songKey('', 'Toxic')).toBe('toxic');
  });

  it('returns empty for a blank title', () => {
    expect(songKey('Britney', '   ')).toBe('');
  });
});

describe('compareVersions (best first)', () => {
  it('prefers FLAC over MP3', () => {
    const [best] = [v({ filename: 'a.mp3', bitRate: 320 }), v({ filename: 'a.flac' })].sort(
      compareVersions,
    );
    expect(best.filename).toBe('a.flac');
  });

  it('prefers higher bitrate within the same format', () => {
    const [best] = [v({ filename: 'a.mp3', bitRate: 128 }), v({ filename: 'b.mp3', bitRate: 320 })].sort(
      compareVersions,
    );
    expect(best.bitRate).toBe(320);
  });

  it('breaks ties by peer availability (free slot, then queue)', () => {
    const [best] = [
      v({ filename: 'a.mp3', bitRate: 320, freeUploadSlots: 0, queueLength: 5 }),
      v({ filename: 'b.mp3', bitRate: 320, freeUploadSlots: 2, queueLength: 0 }),
    ].sort(compareVersions);
    expect(best.filename).toBe('b.mp3');
  });
});

describe('groupBySong', () => {
  it('dedupes the same song across peers and picks the best copy', () => {
    const results = groupBySong([
      v({ username: 'p1', filename: 'Britney - Toxic.mp3', artist: 'Britney', title: 'Toxic', bitRate: 192 }),
      v({ username: 'p2', filename: 'Britney - Toxic.flac', artist: 'Britney', title: 'Toxic' }),
      v({ username: 'p3', filename: 'Britney - Toxic.mp3', artist: 'Britney', title: 'Toxic', bitRate: 320 }),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].versions).toHaveLength(3);
    expect(results[0].best.username).toBe('p2'); // the FLAC
    expect(results[0].title).toBe('Toxic');
  });

  it('keeps distinct songs separate and skips zero-byte files', () => {
    const results = groupBySong([
      v({ filename: 'Toxic.mp3', artist: 'Britney', title: 'Toxic' }),
      v({ filename: 'Oops.mp3', artist: 'Britney', title: 'Oops I Did It Again' }),
      v({ filename: 'empty.mp3', artist: 'Britney', title: 'Toxic', size: 0 }),
    ]);
    expect(results).toHaveLength(2);
  });

  it('ranks query matches first', () => {
    const results = groupBySong(
      [
        v({ filename: 'Lucky.mp3', artist: 'Britney', title: 'Lucky' }),
        v({ filename: 'Toxic.mp3', artist: 'Britney', title: 'Toxic' }),
      ],
      'toxic britney',
    );
    expect(results[0].title).toBe('Toxic');
  });
});

describe('formatBadge', () => {
  it('shows the bare format for lossless and bitrate for lossy', () => {
    expect(formatBadge(v({ filename: 'a.flac' }))).toBe('FLAC');
    expect(formatBadge(v({ filename: 'a.mp3', bitRate: 320 }))).toBe('320k MP3');
    expect(formatBadge(v({ filename: 'a.mp3' }))).toBe('MP3');
  });
});

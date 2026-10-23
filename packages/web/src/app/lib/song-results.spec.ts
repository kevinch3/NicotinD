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
    const [best] = [
      v({ filename: 'a.mp3', bitRate: 128 }),
      v({ filename: 'b.mp3', bitRate: 320 }),
    ].sort(compareVersions);
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
      v({
        username: 'p1',
        filename: 'Britney - Toxic.mp3',
        artist: 'Britney',
        title: 'Toxic',
        bitRate: 192,
      }),
      v({ username: 'p2', filename: 'Britney - Toxic.flac', artist: 'Britney', title: 'Toxic' }),
      v({
        username: 'p3',
        filename: 'Britney - Toxic.mp3',
        artist: 'Britney',
        title: 'Toxic',
        bitRate: 320,
      }),
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

  // #1537, the prod "Damian Lazarus" search: the artist's own track must lead,
  // another act's remix of him next, and an unrelated row last.
  it('ranks an artist match above a title match above a path-only match', () => {
    const results = groupBySong(
      [
        v({
          filename: 'x\\Kassem Mosse\\[untitled].flac',
          artist: 'Kassem Mosse',
          title: '[untitled]',
        }),
        v({
          filename: 'TEED\\A Dream I Have (Damian Lazarus Re-Shape Remix).flac',
          artist: 'TEED',
        }),
        v({ filename: 'music\\Damian Lazarus\\Smoke The Monster Out [2009]\\01. Moment.flac' }),
        v({ filename: 'Lazarus\\Moment.flac', artist: 'Damian Lazarus', title: 'Neverending' }),
      ],
      'Damian Lazarus',
    );
    expect(results.map((r) => r.title)).toEqual([
      'Neverending',
      'A Dream I Have (Damian Lazarus Re-Shape Remix)',
      'Moment',
      '[untitled]',
    ]);
    expect(results.map((r) => r.relevance)).toEqual([6, 4, 2, 0]);
  });

  it('matches a query term regardless of diacritics', () => {
    const [r] = groupBySong(
      [v({ artist: 'Christian Löffler', title: 'Mare' })],
      'christian loffler',
    );
    expect(r.relevance).toBe(6);
  });

  it('folds an untagged copy into the one tagged song with that title', () => {
    const results = groupBySong([
      v({ username: 'a', filename: 'x\\04 Amber Palace.flac' }),
      v({
        username: 'b',
        filename: 'y\\Amber Palace.mp3',
        artist: 'Damian Lazarus',
        title: 'Amber Palace',
      }),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].versions).toHaveLength(2);
    expect(results[0].best.filename).toBe('x\\04 Amber Palace.flac');
  });

  // #1537, the prod rows for "Message From The Other Side": the same track as
  // "Amber Palace" (tagged) and "damian lazarus and the ancient moons-amber palace".
  it('splits an artist prefix the folder confirms off an untagged title, and merges the copy', () => {
    const dir =
      'Elektronika\\Damian Lazarus & The Ancient Moons - Message From The Other Side [2015]';
    const results = groupBySong([
      v({
        username: 'a',
        filename: `${dir}\\damian lazarus and the ancient moons-amber palace.mp3`,
      }),
      v({
        username: 'b',
        filename: 'y\\Amber Palace.flac',
        artist: 'Damian Lazarus',
        title: 'Amber Palace',
      }),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].versions).toHaveLength(2);
  });

  it('leaves a dash inside a title alone when the folder does not name the prefix', () => {
    const [r] = groupBySong([v({ filename: 'Music\\Mix\\Come and Go - Re-Shape.mp3' })]);
    expect(r.title).toBe('Come and Go - Re-Shape');
  });

  it('gives an untagged row an artist hint from its folder, without changing its key', () => {
    const [r] = groupBySong([
      v({ filename: 'Music\\Damian Lazarus\\Smoke The Monster Out [2009]\\03 Moment.flac' }),
    ]);
    expect(r.artist).toBe('');
    expect(r.artistHint).toBe('Damian Lazarus');
    expect(r.key).toBe('moment');
  });

  it('keeps an untagged copy apart when two artists share the title', () => {
    const results = groupBySong([
      v({ filename: 'Intro.flac' }),
      v({ filename: 'a\\Intro.mp3', artist: 'A', title: 'Intro' }),
      v({ filename: 'b\\Intro.mp3', artist: 'B', title: 'Intro' }),
    ]);
    expect(results).toHaveLength(3);
  });
});

describe('formatBadge', () => {
  it('shows the bare format for lossless and bitrate for lossy', () => {
    expect(formatBadge(v({ filename: 'a.flac' }))).toBe('FLAC');
    expect(formatBadge(v({ filename: 'a.mp3', bitRate: 320 }))).toBe('320k MP3');
    expect(formatBadge(v({ filename: 'a.mp3' }))).toBe('MP3');
  });
});

import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { artistTagYield } from './artist-tag-yield.js';
import { libraryHealth } from './library-health.js';
import { sanitizeAlbumTag, sanitizeArtistTag } from './tag-sanitize.js';

let db: Database;
let n = 0;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  n = 0;
});

function songs(artist: string, albumArtist: string | null, count = 1): void {
  for (let i = 0; i < count; i++) {
    const id = `s${++n}`;
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, album_artist, duration,
                                  path, size, created, synced_at, hidden, landed_at)
       VALUES (?, 'al', ?, ?, 'ar', ?, 180, ?, 1, '2024-01-01', 1, 0, 1)`,
      [id, id, artist, albumArtist ?? '', `/m/${id}.opus`],
    );
  }
}

describe('artistTagYield (#864)', () => {
  it('counts nothing for tags the sanitizer leaves alone', () => {
    songs('Soda Stereo', 'Soda Stereo', 3);
    songs('Charlotte de Witte, David Robertson', null);
    expect(artistTagYield(db, 10)).toEqual({
      examined: 3,
      wouldChange: { values: 0, songs: 0 },
      wouldDrop: { values: 0, songs: 0 },
      sample: [],
    });
  });

  it('separates a tag that would change from one that would be dropped, with the songs behind each', () => {
    songs('01. Sailor & I', null, 2);
    songs('Daft Punk feat. Pharrell', null, 4);
    songs('ftpdjemilio.com', null, 3);
    const y = artistTagYield(db, 10);
    expect(y.wouldChange).toEqual({ values: 2, songs: 6 });
    expect(y.wouldDrop).toEqual({ values: 1, songs: 3 });
    expect(y.sample).toEqual([
      { column: 'artist', raw: 'Daft Punk feat. Pharrell', clean: 'Daft Punk', songs: 4 },
      { column: 'artist', raw: 'ftpdjemilio.com', clean: null, songs: 3 },
      { column: 'artist', raw: '01. Sailor & I', clean: 'Sailor & I', songs: 2 },
    ]);
  });

  it('examines the album artist too, as its own column, and bounds the sample', () => {
    songs('Real Artist', '03) Real Artist', 2);
    songs('04 - Other', '04 - Other');
    const y = artistTagYield(db, 1);
    expect(y.examined).toBe(4);
    expect(y.wouldChange).toEqual({ values: 3, songs: 4 });
    expect(y.sample).toEqual([
      { column: 'album_artist', raw: '03) Real Artist', clean: 'Real Artist', songs: 2 },
    ]);
  });

  it('is in the health report, under audit', () => {
    songs('01. Sailor & I', null);
    expect(libraryHealth(db).dimensions.audit.artistTagYield.wouldChange).toEqual({
      values: 1,
      songs: 1,
    });
  });
});

// The sanitizers moved out of the organizer unchanged; these pin what they do.
describe('tag-sanitize', () => {
  it('cleans an artist tag: index, lead junk, featuring suffix, set line', () => {
    expect(sanitizeArtistTag('01. Sailor & I')).toBe('Sailor & I');
    expect(sanitizeArtistTag(', Recondite')).toBe('Recondite');
    expect(sanitizeArtistTag('Daft Punk feat. Pharrell')).toBe('Daft Punk');
    expect(sanitizeArtistTag('Enrico Sangiuliano @ Awakenings')).toBe('Enrico Sangiuliano');
  });

  it('drops an artist tag that is only an index or a watermark', () => {
    expect(sanitizeArtistTag('03.')).toBeUndefined();
    expect(sanitizeArtistTag('ftpdjemilio.com')).toBeUndefined();
    expect(sanitizeArtistTag(undefined)).toBeUndefined();
  });

  it('drops an album tag that is a file name or a watermark, and keeps a real one', () => {
    expect(sanitizeAlbumTag('01 - Track.mp3')).toBeUndefined();
    expect(sanitizeAlbumTag('ftpdjemilio.com')).toBeUndefined();
    expect(sanitizeAlbumTag('1989')).toBe('1989');
    expect(sanitizeAlbumTag('Live @ Wembley')).toBe('Live @ Wembley');
  });
});

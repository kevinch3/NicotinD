import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  DEFAULT_LIBRARY_FORMAT_SETTINGS,
  formatChangeImpact,
  getLibraryFormatSettings,
  setLibraryFormatSettings,
} from './library-format-settings.js';
import { LIBRARY_FORMATS } from './library-format.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

/** A song row in a given container, so the impact count has something to count. */
function seedSong(id: string, suffix: string, hidden = 0): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, suffix, hidden, synced_at)
     VALUES (?, 'a', 'T', 'X', 'art', ?, ?, ?, 1)`,
    [id, `${id}.${suffix}`, suffix, hidden],
  );
}

describe('library format settings', () => {
  it('defaults to the library default when nothing is persisted', () => {
    expect(getLibraryFormatSettings(db)).toEqual(DEFAULT_LIBRARY_FORMAT_SETTINGS);
  });

  it('round-trips a persisted choice', () => {
    expect(setLibraryFormatSettings(db, { format: 'mp3' }).format).toBe('mp3');
    expect(getLibraryFormatSettings(db).format).toBe('mp3');
  });

  it('falls back to the default on a corrupt row rather than throwing', () => {
    // A hand-edited settings row must not take the conversion pass down — it is
    // the pass the operator would use to fix things.
    db.run(`INSERT INTO app_settings (key, value) VALUES ('libraryFormat', '{oops')`);
    expect(getLibraryFormatSettings(db)).toEqual(DEFAULT_LIBRARY_FORMAT_SETTINGS);
  });

  it('falls back when the persisted format is no longer registered', () => {
    // The shape a downgrade produces: a value written by a newer build naming a
    // format this one does not have. Validating against LIBRARY_FORMATS rather
    // than a hand-kept enum is what makes this detectable at all.
    db.run(`INSERT INTO app_settings (key, value) VALUES ('libraryFormat', '{"format":"flac"}')`);
    expect(getLibraryFormatSettings(db)).toEqual(DEFAULT_LIBRARY_FORMAT_SETTINGS);
  });

  it('refuses to persist an unregistered format', () => {
    expect(() =>
      setLibraryFormatSettings(db, { format: 'wma' as keyof typeof LIBRARY_FORMATS }),
    ).toThrow();
  });

  it('offers exactly the registered formats, with no second list to go stale', () => {
    // The enum is built from LIBRARY_FORMATS, so adding a format makes it
    // selectable and removing one stops it validating — without editing this.
    for (const id of Object.keys(LIBRARY_FORMATS) as Array<keyof typeof LIBRARY_FORMATS>) {
      expect(setLibraryFormatSettings(db, { format: id }).format).toBe(id);
    }
  });
});

describe('formatChangeImpact', () => {
  it('reports nothing destructive on an empty library', () => {
    // A fresh install is the case the whole setting exists for: choosing a
    // format before there is anything to convert must be free.
    expect(formatChangeImpact(db, 'mp3')).toEqual({
      alreadyTarget: 0,
      wouldReEncode: 0,
      destructive: false,
    });
  });

  it('counts what a change would re-encode, and what it would not', () => {
    seedSong('a', 'opus');
    seedSong('b', 'opus');
    seedSong('c', 'mp3');

    const toMp3 = formatChangeImpact(db, 'mp3');
    expect(toMp3).toEqual({ alreadyTarget: 1, wouldReEncode: 2, destructive: true });

    const toOpus = formatChangeImpact(db, 'opus');
    expect(toOpus).toEqual({ alreadyTarget: 2, wouldReEncode: 1, destructive: true });
  });

  it('is not destructive when the whole library is already the target', () => {
    // The real reason this is counted rather than assumed: "did anything
    // change?" is not the same question as "is this format different", and only
    // the first one should make an operator confirm.
    seedSong('a', 'opus');
    seedSong('b', 'opus');
    expect(formatChangeImpact(db, 'opus')).toEqual({
      alreadyTarget: 2,
      wouldReEncode: 0,
      destructive: false,
    });
  });

  it('ignores hidden songs, which the pass also skips', () => {
    seedSong('a', 'mp3');
    seedSong('hidden', 'mp3', 1);
    expect(formatChangeImpact(db, 'opus').wouldReEncode).toBe(1);
  });
});

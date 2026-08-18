import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from '../db.js';
import { carryArtistCuration } from './artist-curation-carry.js';

let db: Database;
let dataDir: string;
const OVERRIDES = () => join(dataDir, 'artist-overrides');

function seedArtwork(id: string, url = 'https://cdn/a.jpg') {
  db.run(
    `INSERT INTO library_artwork (id, kind, cover_url, updated_at) VALUES (?, 'artist', ?, 1)`,
    [id, url],
  );
}
function seedMeta(id: string, bio = 'a bio') {
  db.run(
    `INSERT INTO library_artist_meta (artist_id, bio, urls, fetched_at, source, manual_override)
     VALUES (?, ?, '[]', 1, 'user', 1)`,
    [id, bio],
  );
}
function seedUpload(id: string, ext = '.jpg') {
  mkdirSync(OVERRIDES(), { recursive: true });
  writeFileSync(join(OVERRIDES(), id + ext), 'bytes');
}
function seedGenre(key: string, genres = 'Rap') {
  db.run(
    `INSERT INTO library_genre_overrides (scope, key, genres, source, status, created_at, updated_at)
     VALUES ('artist', ?, ?, 'user', 'applied', 1, 1)`,
    [key, genres],
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  dataDir = mkdtempSync(join(tmpdir(), 'carry-'));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

/**
 * Artist ids derive from the name, so a rename/merge mints a new id and every
 * artist-scoped side table — keyed on the old id, with no FK — is silently
 * detached. Prod measured 88 dead artwork rows (8.7%) and 2 orphaned uploads,
 * which are user work: somebody chose that image.
 */
describe('carryArtistCuration (#305)', () => {
  it('moves artwork, the uploaded file and the bio onto the new id', () => {
    seedArtwork('old');
    seedMeta('old');
    seedUpload('old');

    const r = carryArtistCuration(db, dataDir, { fromId: 'old', toId: 'new' });

    expect(r).toMatchObject({ artwork: true, meta: true, overrideFile: true });
    expect(db.query(`SELECT id FROM library_artwork WHERE kind='artist'`).all()).toEqual([
      { id: 'new' },
    ]);
    expect(db.query(`SELECT artist_id FROM library_artist_meta`).all()).toEqual([
      { artist_id: 'new' },
    ]);
    expect(existsSync(join(OVERRIDES(), 'new.jpg'))).toBe(true);
    expect(existsSync(join(OVERRIDES(), 'old.jpg'))).toBe(false);
  });

  it('moves the origin row and never clobbers the destination', () => {
    db.run(
      `INSERT INTO library_artist_origins (artist_id, country, source, checked_at)
       VALUES ('old', 'AR', 'user', 1)`,
    );
    const r1 = carryArtistCuration(db, undefined, { fromId: 'old', toId: 'new' });
    expect(r1.origin).toBe(true);
    expect(
      db.query(`SELECT artist_id FROM library_artist_origins WHERE artist_id = 'new'`).get(),
    ).toBeTruthy();

    db.run(
      `INSERT INTO library_artist_origins (artist_id, country, source, checked_at)
       VALUES ('old2', 'CL', 'musicbrainz', 1)`,
    );
    const r2 = carryArtistCuration(db, undefined, { fromId: 'old2', toId: 'new' });
    expect(r2.origin).toBe(false); // 'new' already has its own origin
  });

  /**
   * A merge lands on an artist that may already be curated, and the
   * destination's choice is the more deliberate one — it was set on the artist
   * that survives.
   */
  it('never clobbers curation the destination already has', () => {
    seedArtwork('old', 'https://cdn/OLD.jpg');
    seedArtwork('new', 'https://cdn/KEEP.jpg');
    seedMeta('old', 'old bio');
    seedMeta('new', 'keep bio');
    seedUpload('old');
    seedUpload('new', '.png');

    const r = carryArtistCuration(db, dataDir, { fromId: 'old', toId: 'new' });

    expect(r).toMatchObject({ artwork: false, meta: false, overrideFile: false });
    expect(db.query(`SELECT cover_url FROM library_artwork WHERE id='new'`).get()).toEqual({
      cover_url: 'https://cdn/KEEP.jpg',
    });
    expect(db.query(`SELECT bio FROM library_artist_meta WHERE artist_id='new'`).get()).toEqual({
      bio: 'keep bio',
    });
    expect(existsSync(join(OVERRIDES(), 'new.png'))).toBe(true);
  });

  /**
   * Artist genre overrides key on normalizeArtistForGrouping(name), NOT the id
   * — verified against prod, where the row is `key = "ana tijoux"`. So the
   * rename moves that key while artwork/meta move by id.
   */
  it('moves the genre override by NAME key, not by id', () => {
    seedGenre('ana tijoux');
    const r = carryArtistCuration(db, dataDir, {
      fromId: 'old',
      toId: 'new',
      fromKey: 'ana tijoux',
      toKey: 'anita tijoux',
    });
    expect(r.genreOverride).toBe(true);
    expect(db.query(`SELECT key FROM library_genre_overrides`).all()).toEqual([
      { key: 'anita tijoux' },
    ]);
  });

  it('leaves the genre override alone when the normalized name is unchanged', () => {
    // An accent/case-only rename keeps the same normalized key.
    seedGenre('ana tijoux');
    const r = carryArtistCuration(db, dataDir, {
      fromId: 'old',
      toId: 'new',
      fromKey: 'ana tijoux',
      toKey: 'ana tijoux',
    });
    expect(r.genreOverride).toBe(false);
    expect(db.query(`SELECT key FROM library_genre_overrides`).all()).toEqual([
      { key: 'ana tijoux' },
    ]);
  });

  it('is a no-op when the id does not actually change', () => {
    seedArtwork('same');
    const r = carryArtistCuration(db, dataDir, { fromId: 'same', toId: 'same' });
    expect(r).toEqual({
      artwork: false,
      overrideFile: false,
      meta: false,
      origin: false,
      genreOverride: false,
    });
    expect(db.query(`SELECT id FROM library_artwork`).all()).toEqual([{ id: 'same' }]);
  });

  it('works without a dataDir (DB rows still move)', () => {
    seedArtwork('old');
    const r = carryArtistCuration(db, undefined, { fromId: 'old', toId: 'new' });
    expect(r.artwork).toBe(true);
    expect(r.overrideFile).toBe(false);
  });

  it('carries any supported image variant, not just .jpg', () => {
    seedUpload('old', '.webp');
    expect(carryArtistCuration(db, dataDir, { fromId: 'old', toId: 'new' }).overrideFile).toBe(
      true,
    );
    expect(existsSync(join(OVERRIDES(), 'new.webp'))).toBe(true);
  });
});

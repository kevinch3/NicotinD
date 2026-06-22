import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { planRetag, collectRetagTargets } from './library-retag.js';

describe('planRetag', () => {
  it('parses a numeric-artist mis-split with an embedded "YYYY - Artist - Album" title', () => {
    const plan = planRetag({
      artist: '101',
      album: '1968 - Astor Piazzolla - MARÍA DE BUENOS AIRES',
      songTitle: 'Alevare',
      songCount: 1,
    });
    expect(plan).toEqual({
      request: { artist: 'Astor Piazzolla', album: 'MARÍA DE BUENOS AIRES', year: 1968, source: 'manual' },
      reason: 'numeric-artist-embedded',
    });
  });

  it('collapses a watermark album under a real artist into a single titled by its track', () => {
    const plan = planRetag({
      artist: 'RÜFÜS DU SOL',
      album: 'ftpdjemilio.com',
      songTitle: 'Innerbloom (Original Mix)',
      songCount: 1,
    });
    expect(plan).toEqual({
      request: { album: 'Innerbloom (Original Mix)', source: 'manual' },
      reason: 'watermark-album-to-single',
    });
  });

  it('leaves a clean album alone', () => {
    expect(
      planRetag({ artist: 'Soda Stereo', album: 'Dynamo', songTitle: 'En El Borde', songCount: 9 }),
    ).toBeNull();
  });

  it('does not collapse a watermark album when the song title is unknown', () => {
    expect(
      planRetag({ artist: 'UMEK', album: 'MUSICAUNO.COM', songTitle: 'Unknown', songCount: 1 }),
    ).toBeNull();
  });

  it('skips a numeric artist whose album title is not parseable', () => {
    expect(planRetag({ artist: '101', album: 'Some Mixtape', songTitle: 'x', songCount: 1 })).toBeNull();
  });

  it('skips the inverted mis-tag where the song title is itself a watermark (no-op, non-converging)', () => {
    // "DJ KAIRUZ- SERVICIO ARG" dumps: real track name is in the artist field,
    // both album AND title are the watermark → not clean re-tag fruit.
    expect(
      planRetag({
        artist: 'SEXY BITCH',
        album: 'DJ KAIRUZ- SERVICIO ARG',
        songTitle: 'DJ KAIRUZ- SERVICIO ARG',
        songCount: 1,
      }),
    ).toBeNull();
  });
});

describe('collectRetagTargets', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  function seed(albumId: string, name: string, artist: string, title: string): void {
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, classification, synced_at)
       VALUES (?, ?, ?, 'ar', 1, 'single', 1)`,
      [albumId, name, artist],
    );
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at)
       VALUES (?, ?, ?, ?, 'ar', ?, 1)`,
      [`s-${albumId}`, albumId, title, artist, `/m/${albumId}.opus`],
    );
  }

  it('finds both patterns and ignores clean albums', () => {
    seed('p1', '1968 - Astor Piazzolla - MARÍA DE BUENOS AIRES', '101', 'Alevare');
    seed('w1', 'MUSICAUNO.COM', 'UMEK', 'Managing The Moments');
    seed('ok', 'Dynamo', 'Soda Stereo', 'En El Borde');
    const targets = collectRetagTargets(db);
    const reasons = targets.map((t) => t.plan.reason).sort();
    expect(reasons).toEqual(['numeric-artist-embedded', 'watermark-album-to-single']);
  });
});

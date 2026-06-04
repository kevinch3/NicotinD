import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { PlaylistService } from './playlist.service.js';

let db: Database;
let svc: PlaylistService;

beforeEach(() => {
  db = new Database(':memory:');
  db.run('PRAGMA foreign_keys=ON');
  applySchema(db);
  svc = new PlaylistService(db);
  db.run(
    `INSERT INTO users (id, username, password_hash) VALUES ('u1', 'a', 'x'), ('u2', 'b', 'y')`,
  );
  for (const id of ['s1', 's2', 's3']) {
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, synced_at)
       VALUES (?, 'alb', ?, 'A', 'art', 60, ?, 1)`,
      [id, id.toUpperCase(), `p/${id}.mp3`],
    );
  }
});

describe('PlaylistService', () => {
  it('creates a playlist with initial songs scoped to the user', () => {
    const pl = svc.create('u1', { name: 'Roadtrip', songIds: ['s1', 's2'] });
    expect(pl.name).toBe('Roadtrip');
    expect(pl.songCount).toBe(2);

    const detail = svc.get('u1', pl.id);
    expect(detail?.songs.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('isolates playlists per user', () => {
    const pl = svc.create('u1', { name: 'Mine' });
    expect(svc.list('u2')).toHaveLength(0);
    expect(svc.get('u2', pl.id)).toBeNull();
    expect(svc.update('u2', pl.id, { name: 'Hijack' })).toBe(false);
    expect(svc.remove('u2', pl.id)).toBe(false);
    // Owner still sees it untouched.
    expect(svc.get('u1', pl.id)?.name).toBe('Mine');
  });

  it('adds, removes, and reorders songs', () => {
    const pl = svc.create('u1', { name: 'P', songIds: ['s1', 's2'] });
    svc.update('u1', pl.id, { add: ['s3'] });
    expect(svc.get('u1', pl.id)?.songs.map((s) => s.id)).toEqual(['s1', 's2', 's3']);

    svc.update('u1', pl.id, { remove: ['s2'] });
    expect(svc.get('u1', pl.id)?.songs.map((s) => s.id)).toEqual(['s1', 's3']);

    svc.update('u1', pl.id, { reorder: ['s3', 's1'] });
    expect(svc.get('u1', pl.id)?.songs.map((s) => s.id)).toEqual(['s3', 's1']);
  });

  it('ignores duplicate adds', () => {
    const pl = svc.create('u1', { name: 'P', songIds: ['s1'] });
    svc.update('u1', pl.id, { add: ['s1', 's2'] });
    expect(svc.get('u1', pl.id)?.songs.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('drops songs whose file no longer exists on read', () => {
    const pl = svc.create('u1', { name: 'P', songIds: ['s1', 's2'] });
    db.run(`DELETE FROM library_songs WHERE id = 's1'`); // simulate a moved/renamed file
    const detail = svc.get('u1', pl.id);
    expect(detail?.songs.map((s) => s.id)).toEqual(['s2']);
    expect(detail?.songCount).toBe(1);
  });

  it('renames a playlist', () => {
    const pl = svc.create('u1', { name: 'Old' });
    expect(svc.update('u1', pl.id, { name: 'New' })).toBe(true);
    expect(svc.get('u1', pl.id)?.name).toBe('New');
  });

  it('deletes a playlist and cascades its songs', () => {
    const pl = svc.create('u1', { name: 'P', songIds: ['s1'] });
    expect(svc.remove('u1', pl.id)).toBe(true);
    expect(svc.get('u1', pl.id)).toBeNull();
    expect(db.query('SELECT COUNT(*) AS c FROM playlist_songs').get()).toEqual({ c: 0 });
  });
});

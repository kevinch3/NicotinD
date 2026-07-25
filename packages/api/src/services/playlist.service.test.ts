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

describe('PlaylistService — likes / Liked Songs playlist', () => {
  it('creates the Liked Songs playlist lazily on first like and round-trips', () => {
    // No liked playlist until the first like.
    expect(svc.likedSongIds('u1')).toEqual([]);
    expect(svc.list('u1')).toHaveLength(0);

    svc.likeSong('u1', 's1');
    expect(svc.likedSongIds('u1')).toEqual(['s1']);

    // It materializes as a real kind='liked' playlist pinned first.
    const [liked] = svc.list('u1');
    expect(liked.kind).toBe('liked');
    expect(liked.name).toBe('Liked Songs');
    expect(liked.songCount).toBe(1);

    svc.unlikeSong('u1', 's1');
    expect(svc.likedSongIds('u1')).toEqual([]);
  });

  it('is idempotent (a second like is a no-op) and dedupes', () => {
    svc.likeSong('u1', 's1');
    svc.likeSong('u1', 's1');
    expect(svc.likedSongIds('u1')).toEqual(['s1']);
    expect(db.query('SELECT COUNT(*) AS c FROM playlist_songs').get()).toEqual({ c: 1 });
  });

  it('orders newest-liked first', () => {
    svc.likeSong('u1', 's1');
    svc.likeSong('u1', 's2');
    svc.likeSong('u1', 's3');
    expect(svc.likedSongIds('u1')).toEqual(['s3', 's2', 's1']);
  });

  it('keeps likes per-user', () => {
    svc.likeSong('u1', 's1');
    expect(svc.likedSongIds('u2')).toEqual([]);
    svc.likeSong('u2', 's2');
    expect(svc.likedSongIds('u1')).toEqual(['s1']);
    expect(svc.likedSongIds('u2')).toEqual(['s2']);
  });

  it('drops liked ids whose song no longer exists', () => {
    svc.likeSong('u1', 's1');
    svc.likeSong('u1', 's2');
    db.run(`DELETE FROM library_songs WHERE id = 's1'`);
    expect(svc.likedSongIds('u1')).toEqual(['s2']);
  });

  it('unlike is a no-op when nothing has been liked', () => {
    expect(svc.unlikeSong('u1', 's1')).toBe(false);
  });

  it('keeps the Liked Songs playlist read-only through the CRUD API', () => {
    svc.likeSong('u1', 's1');
    const [liked] = svc.list('u1');
    // Owner can view it, but the mutation API's kind='user' guard rejects edits.
    expect(svc.get('u1', liked.id)?.kind).toBe('liked');
    expect(svc.update('u1', liked.id, { name: 'Hijacked' })).toBe(false);
    expect(svc.remove('u1', liked.id)).toBe(false);
  });
});

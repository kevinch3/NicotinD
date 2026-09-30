import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../db.js';
import { songId } from '../services/library-scanner.js';
import { runMigration } from './migrate-multidisc-names.js';

// Through the real entry point, asserting the effect on disk: a spy on the
// service would pass even if the CLI never took its snapshot.
describe('migrate-multidisc-names', () => {
  let root: string;
  let dataDir: string;
  let musicDir: string;
  const files: [string, number][] = [
    ['Artist/Set/01 - Intro.opus', 1],
    ['Artist/Set/01 - Outro (2).opus', 2],
    ['Artist/Solo/01 - Only.opus', 1],
  ];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mdn-'));
    dataDir = join(root, 'data');
    musicDir = join(root, 'music');
    mkdirSync(dataDir);
    const db = new Database(join(dataDir, 'nicotind.db'));
    applySchema(db);
    db.run(`INSERT INTO users (id, username, password_hash) VALUES ('u', 'u', 'x')`);
    db.run(
      `INSERT INTO playlists (id, user_id, name, created_at, modified_at) VALUES ('p', 'u', 'P', 1, 1)`,
    );
    files.forEach(([p, disc], i) => {
      mkdirSync(join(musicDir, p, '..'), { recursive: true });
      writeFileSync(join(musicDir, p), `bytes-${i}`);
      const title = p.includes('Outro') ? 'Outro' : 'x';
      db.run(
        `INSERT INTO library_songs (id, album_id, title, artist, artist_id, track, disc, path, starred, synced_at)
         VALUES (?, 'alb', ?, 'Artist', 'art', 1, ?, ?, '2026-01-01', 1)`,
        [songId(p), title, disc, p],
      );
      db.run(
        `INSERT INTO playlist_songs (playlist_id, song_id, position, added_at) VALUES ('p', ?, ?, 1)`,
        [songId(p), i],
      );
    });
    db.close();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const quiet = () => {};
  const now = () => new Date('2026-09-30T12:00:00Z');

  it('a dry run writes nothing — no rename, no snapshot, no journal', () => {
    const r = runMigration({ dataDir, musicDir, mode: 'dry-run', log: quiet, now });
    expect(r.planned).toBe(2);
    expect(existsSync(join(musicDir, files[1]![0]))).toBe(true);
    expect(existsSync(join(dataDir, 'backups'))).toBe(false);
  });

  it('--apply snapshots first, renames, carries, and a second apply finds nothing', () => {
    const r = runMigration({ dataDir, musicDir, mode: 'apply', log: quiet, now });
    expect(r.applied).toBe(2);
    expect(r.remaining).toBe(0);
    expect(existsSync(r.snapshot!)).toBe(true);
    expect(existsSync(r.journal!)).toBe(true);
    expect(readdirSync(join(musicDir, 'Artist/Set')).sort()).toEqual([
      '1-01 - Intro.opus',
      '2-01 - Outro.opus',
    ]);
    expect(r.after).toEqual(r.before);
    // The snapshot is the pre-run library.
    const snap = new Database(r.snapshot!, { readonly: true });
    expect(
      snap.query('SELECT COUNT(*) AS c FROM library_songs WHERE path LIKE ?').get('%(2)%'),
    ).toEqual({ c: 1 });
    snap.close();

    const again = runMigration({
      dataDir,
      musicDir,
      mode: 'apply',
      log: quiet,
      now: () => new Date(),
    });
    expect(again).toMatchObject({ planned: 0, applied: 0, remaining: 0 });
    expect(again.snapshot).toBeUndefined();
  });

  it('--revert puts the names, ids and playlist rows back', () => {
    const r = runMigration({ dataDir, musicDir, mode: 'apply', log: quiet, now });
    const back = runMigration({
      dataDir,
      musicDir,
      mode: 'revert',
      journal: r.journal!,
      log: quiet,
      now,
    });
    expect(back.applied).toBe(2);
    const db = new Database(join(dataDir, 'nicotind.db'), { readonly: true });
    const ids = db
      .query<{ song_id: string }, []>('SELECT song_id FROM playlist_songs ORDER BY position')
      .all()
      .map((x) => x.song_id);
    db.close();
    expect(ids).toEqual(files.map(([p]) => songId(p)));
    expect(existsSync(join(musicDir, files[1]![0]))).toBe(true);
  });
});

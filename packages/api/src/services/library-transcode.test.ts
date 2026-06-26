/**
 * Tests for the existing-library lossless → Opus conversion, with focus on the
 * songId identity migration (playlist entries, acquisitions, starred carried
 * across the extension/id change). Generates real FLACs via ffmpeg + a real
 * in-memory DB; the apply-path tests skip when ffmpeg is absent (CI has it).
 */
import { describe, expect, it, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { transcodeLibraryToOpus } from './library-transcode.js';
import { songId } from './library-scanner.js';
import { ffmpegAvailable } from './transcode.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpMusic() {
  mkdirSync(tmpdir(), { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'nicotind-libxc-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeFlac(musicDir: string, rel: string, title: string): void {
  const dest = join(musicDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=mono:sample_rate=22050',
      '-t',
      '0.3',
      '-c:a',
      'flac',
      '-metadata',
      'ARTIST=Aphex Twin',
      '-metadata',
      'ALBUM=Drukqs',
      '-metadata',
      `TITLE=${title}`,
      dest,
    ],
    { stdio: 'ignore' },
  );
}

function seedSongRow(db: Database, rel: string, extra: { starred?: string; hidden?: number } = {}) {
  const id = songId(rel);
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, suffix, size, starred, hidden, synced_at)
     VALUES (?, 'alb', 'Avril 14th', 'Aphex Twin', 'art', ?, 'flac', 1000, ?, ?, 1)`,
    [id, rel, extra.starred ?? null, extra.hidden ?? 0],
  );
  return id;
}

describe('transcodeLibraryToOpus', () => {
  it('dry run reports candidates without touching disk or db', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'Aphex Twin/Drukqs/01 - Avril 14th.flac';
    mkdirSync(dirname(join(music, rel)), { recursive: true });
    await Bun.write(join(music, rel), 'x'); // dry-run only existsSync-checks
    seedSongRow(db, rel);

    const r = await transcodeLibraryToOpus(db, music, { apply: false });
    expect(r.candidates).toBe(1);
    expect(r.converted).toBe(1); // would-convert count
    // Row unchanged (still flac).
    const row = db.query<{ suffix: string }, []>('SELECT suffix FROM library_songs').get();
    expect(row?.suffix).toBe('flac');
  });

  it.skipIf(!ffmpegAvailable())(
    'converts FLAC→opus and migrates playlist + acquisition + starred to the new id',
    async () => {
      const music = tmpMusic();
      const db = new Database(':memory:');
      applySchema(db);

      const rel = 'Aphex Twin/Drukqs/01 - Avril 14th.flac';
      makeFlac(music, rel, 'Avril 14th');
      const oldId = seedSongRow(db, rel, { starred: '2024-01-01T00:00:00Z', hidden: 1 });

      // A playlist referencing the song, and an acquisition keyed on its path.
      db.run(
        "INSERT INTO playlists (id, user_id, name, created_at, modified_at) VALUES ('pl', 'u', 'Mix', 1, 1)",
      );
      db.run(
        'INSERT INTO playlist_songs (playlist_id, song_id, position, added_at) VALUES (?, ?, 0, 1)',
        ['pl', oldId],
      );
      db.run(
        "INSERT INTO acquisitions (relative_path, method, source_ref, stage, started_at) VALUES (?, 'slskd', 'peer', 'done', 1)",
        [rel],
      );

      const r = await transcodeLibraryToOpus(db, music, { apply: true, bitRate: 96 });
      expect(r.converted).toBe(1);
      expect(r.failed).toBe(0);

      const newRel = 'Aphex Twin/Drukqs/01 - Avril 14th.opus';
      const newId = songId(newRel);

      // Old row gone, new opus row present with carried curation.
      expect(db.query('SELECT id FROM library_songs WHERE id = ?').get(oldId)).toBeNull();
      const newRow = db
        .query<
          { suffix: string; starred: string | null; hidden: number; path: string },
          [string]
        >('SELECT suffix, starred, hidden, path FROM library_songs WHERE id = ?')
        .get(newId);
      expect(newRow?.suffix).toBe('opus');
      expect(newRow?.path).toBe(newRel);
      expect(newRow?.starred).toBe('2024-01-01T00:00:00Z');
      expect(newRow?.hidden).toBe(1);

      // Playlist + acquisition re-pointed to the new id/path.
      const pl = db.query<{ song_id: string }, []>('SELECT song_id FROM playlist_songs').get();
      expect(pl?.song_id).toBe(newId);
      const acq = db
        .query<{ relative_path: string }, []>('SELECT relative_path FROM acquisitions')
        .get();
      expect(acq?.relative_path).toBe(newRel);
    },
  );

  it.skipIf(!ffmpegAvailable())(
    'survives a pre-existing acquisitions row at the opus path (dup) instead of crashing on the PK',
    async () => {
      const music = tmpMusic();
      const db = new Database(':memory:');
      applySchema(db);

      const rel = 'Aphex Twin/Drukqs/01 - Avril 14th.flac';
      makeFlac(music, rel, 'Avril 14th');
      const oldId = seedSongRow(db, rel);

      const newRel = 'Aphex Twin/Drukqs/01 - Avril 14th.opus';
      // Provenance for BOTH the lossless source and a pre-existing opus dup. The
      // re-point used to collide on the relative_path PK and abort the migration.
      db.run(
        "INSERT INTO acquisitions (relative_path, method, source_ref, stage, started_at) VALUES (?, 'slskd', 'flac-peer', 'done', 1)",
        [rel],
      );
      db.run(
        "INSERT INTO acquisitions (relative_path, method, source_ref, stage, started_at) VALUES (?, 'slskd', 'opus-peer', 'done', 1)",
        [newRel],
      );

      const r = await transcodeLibraryToOpus(db, music, { apply: true, bitRate: 96 });
      expect(r.converted).toBe(1);
      expect(r.failed).toBe(0);

      // Exactly one acquisitions row remains at the opus path — the pre-existing
      // one is kept, the stale lossless row dropped.
      expect(db.query('SELECT id FROM library_songs WHERE id = ?').get(oldId)).toBeNull();
      const acqs = db
        .query<
          { relative_path: string; source_ref: string },
          []
        >('SELECT relative_path, source_ref FROM acquisitions')
        .all();
      expect(acqs).toHaveLength(1);
      expect(acqs[0]?.relative_path).toBe(newRel);
      expect(acqs[0]?.source_ref).toBe('opus-peer');
    },
  );

  it.skipIf(!ffmpegAvailable())('leaves already-lossy rows untouched', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    // An mp3 row — not a transcode candidate.
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, suffix, synced_at)
       VALUES ('m', 'alb', 'T', 'A', 'art', 'A/B/01.mp3', 'mp3', 1)`,
    );
    const r = await transcodeLibraryToOpus(db, music, { apply: true });
    expect(r.candidates).toBe(0);
    expect(r.converted).toBe(0);
  });
});

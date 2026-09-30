import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  linkSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../db.js';
import { songId } from './library-scanner.js';
import { SONG_CARRY_TABLES } from './song-curation-carry.js';
import {
  planMultiDiscRenames,
  stageRenames,
  applyRenames,
  revertRenames,
  migrateSongIdentity,
  RENAME_ALSO_MOVES,
  RENAME_KEEPS,
  type RenameRow,
} from './multidisc-rename.js';

function seedUser(db: Database): void {
  db.run(`INSERT INTO users (id, username, password_hash) VALUES ('u', 'u', 'x')`);
  db.run(
    `INSERT INTO playlists (id, user_id, name, created_at, modified_at) VALUES ('p', 'u', 'P', 1, 1)`,
  );
}

const reserved = new Set(['.downloads', '.unsorted']);
const row = (path: string, disc: number | null, track: number | null = 1): RenameRow => ({
  id: songId(path),
  path,
  disc,
  track,
});

describe('planMultiDiscRenames', () => {
  it('renames every file of a multi-disc folder to D-NN and strips a collision suffix', () => {
    const plan = planMultiDiscRenames(
      [
        row('A/Album/01 - Intro.opus', 1),
        row('A/Album/01 - Intro (2).opus', 2),
        row('A/Album/02 - Song.opus', 1, 2),
      ],
      reserved,
    );
    expect(plan.renames.map((r) => [r.from, r.to, r.suffixStripped])).toEqual([
      ['A/Album/01 - Intro.opus', 'A/Album/1-01 - Intro.opus', false],
      ['A/Album/01 - Intro (2).opus', 'A/Album/2-01 - Intro.opus', true],
      ['A/Album/02 - Song.opus', 'A/Album/1-02 - Song.opus', false],
    ]);
    expect(plan.renames[1]!.toId).toBe(songId('A/Album/2-01 - Intro.opus'));
    expect(plan.multiDiscFolders).toBe(1);
  });

  it('leaves single-disc folders, Singles, unsorted and reserved paths alone', () => {
    const plan = planMultiDiscRenames(
      [
        row('A/Solo/01 - One.opus', 1),
        row('A/Solo/02 - Two (2).opus', null),
        row('A/Singles/01 - Loose.opus', 2),
        row('.unsorted/x/01 - Y.opus', 2),
        row('.downloads/A/B/01 - Y.opus', 2),
        row('A/Album/._01 - Z.opus', 2),
      ],
      reserved,
    );
    expect(plan.renames).toEqual([]);
    expect(plan.multiDiscFolders).toBe(0);
  });

  it('counts an already-renamed file as done, so a re-plan after an apply is empty', () => {
    const plan = planMultiDiscRenames(
      [row('A/Album/1-01 - Intro.opus', 1), row('A/Album/2-01 - Intro.opus', 2)],
      reserved,
    );
    expect(plan.renames).toEqual([]);
    expect(plan.alreadyDone).toBe(2);
  });

  it('keeps stripping a suffix once its sibling is already renamed (idempotent resume)', () => {
    const plan = planMultiDiscRenames(
      [row('A/Album/1-01 - Intro.opus', 1), row('A/Album/01 - Intro (2).opus', 2)],
      reserved,
    );
    expect(plan.renames.map((r) => r.to)).toEqual(['A/Album/2-01 - Intro.opus']);
  });

  it('classifies a same-disc suffix as a genuine duplicate and renames neither', () => {
    const plan = planMultiDiscRenames(
      [
        row('A/Album/01 - Intro.opus', 1),
        row('A/Album/01 - Intro (2).opus', 1),
        row('A/Album/01 - Other.opus', 2),
      ],
      reserved,
    );
    expect(plan.renames.map((r) => r.to)).toEqual(['A/Album/2-01 - Other.opus']);
    expect(plan.skipped.filter((s) => s.reason === 'duplicate').map((s) => s.path)).toEqual([
      'A/Album/01 - Intro.opus',
      'A/Album/01 - Intro (2).opus',
    ]);
  });

  it('refuses a target another row already holds', () => {
    const plan = planMultiDiscRenames(
      [row('A/Album/2-01 - Intro.opus', 2), row('A/Album/01 - Intro (2).opus', 2)],
      reserved,
    );
    expect(plan.renames).toEqual([]);
    expect(plan.skipped[0]).toEqual({ path: 'A/Album/01 - Intro (2).opus', reason: 'duplicate' });
  });

  it('keeps a parenthesised number the tag title carries, or when there is no title to ask', () => {
    const plan = planMultiDiscRenames(
      [
        { ...row('A/Album/03 - Part (2).opus', 2, 3), title: 'Part (2)' },
        row('A/Album/04 - Untitled (2).opus', 2, 4),
        row('A/Album/01 - X.opus', 1),
      ],
      reserved,
    );
    expect(plan.renames.map((r) => r.to)).toContain('A/Album/2-03 - Part (2).opus');
    expect(plan.renames.map((r) => r.to)).toContain('A/Album/2-04 - Untitled (2).opus');
  });

  it('strips a suffix the tag title does not carry, though its sibling is gone', () => {
    const plan = planMultiDiscRenames(
      [
        { ...row('A/Album/03 - Respectable (2).opus', 2, 3), title: 'Respectable' },
        row('A/Album/01 - X.opus', 1),
      ],
      reserved,
    );
    expect(plan.renames[0]).toMatchObject({
      to: 'A/Album/2-03 - Respectable.opus',
      suffixStripped: true,
    });
  });

  it('skips what it cannot name: no disc tag, a non-organizer stem, a disc that disagrees', () => {
    const plan = planMultiDiscRenames(
      [
        row('A/Album/01 - X.opus', 2),
        row('A/Album/02 - Y.opus', null),
        row('A/Album/Some raw name.opus', 1),
        row('A/Album/1-05 - Z.opus', 2),
      ],
      reserved,
    );
    expect(plan.renames.map((r) => r.to)).toEqual(['A/Album/2-01 - X.opus']);
    expect(Object.fromEntries(plan.skipped.map((s) => [s.path, s.reason]))).toEqual({
      'A/Album/02 - Y.opus': 'no-disc',
      'A/Album/Some raw name.opus': 'unparsed',
      'A/Album/1-05 - Z.opus': 'disc-mismatch',
    });
  });
});

describe('rename coverage', () => {
  // The same name-based sweep `check:song-carry-coverage` runs, plus the
  // `target_kind`/`target_id` shape it cannot see. A new song-keyed table fails
  // here until the rename either moves it or records why it keeps it.
  it('classifies every song-keyed column in the live schema', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all()
      .map((r) => r.name);
    const found: string[] = [];
    for (const t of tables) {
      const cols = db
        .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${t}')`)
        .all()
        .map((c) => c.name);
      for (const c of cols) {
        if (/song_id|song_path|^target_id$/.test(c)) found.push(`${t}.${c}`);
      }
    }
    const classified = new Set([
      ...SONG_CARRY_TABLES.map((e) => `${e.table}.${e.column}`),
      ...RENAME_ALSO_MOVES.map((e) => `${e.table}.${e.column}`),
      ...RENAME_KEEPS.map((e) => `${e.table}.${e.column}`),
    ]);
    const unclassified = found.filter((f) => !classified.has(f));
    expect(unclassified).toEqual([]);
    expect(found.length).toBeGreaterThan(10);
  });
});

describe('migrateSongIdentity', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('moves the row, its curation and every rename-carried table onto the new id', () => {
    const from = 'A/Album/01 - Intro (2).opus';
    const to = 'A/Album/2-01 - Intro.opus';
    const [a, b] = [songId(from), songId(to)];
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, track, disc, path, starred, hidden, bpm, synced_at)
       VALUES (?, 'alb', 'Intro', 'A', 'art', 1, 2, ?, '2026-01-01', 0, 120, 1)`,
      [a, from],
    );
    db.run(`INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
            VALUES ('alb', 'Album', 'A', 'art', 1, 0, 1)`);
    seedUser(db);
    db.run(
      `INSERT INTO playlist_songs (playlist_id, song_id, position, added_at) VALUES ('p', ?, 0, 1)`,
      [a],
    );
    db.run(
      `INSERT INTO library_song_artists (song_id, artist_id, role, position) VALUES (?, 'art', 'primary', 0)`,
      [a],
    );
    db.run(
      `INSERT INTO play_events (client_event_id, song_id, user_id, title, at, ms_played, counted, reason) VALUES ('e1', ?, 'u', 'Intro', 1, 1000, 1, 'ended')`,
      [a],
    );
    db.run(
      `INSERT INTO curation_flags (target_kind, target_id, reason, created_by, created_at) VALUES ('song', ?, 'r', 'c', 1)`,
      [a],
    );
    db.run(`INSERT INTO scan_cache (path, size, mtime_ms, track_json) VALUES (?, 1, 1, '{}')`, [
      from,
    ]);

    const r = db.transaction(() => migrateSongIdentity(db, { fromId: a, toId: b, from, to }))();

    expect(r.rowMoved).toBe(true);
    const moved = db
      .query<{ id: string; path: string; starred: string; bpm: number }, []>(
        'SELECT id, path, starred, bpm FROM library_songs',
      )
      .all();
    expect(moved).toEqual([{ id: b, path: to, starred: '2026-01-01', bpm: 120 }]);
    for (const [table, col, kind] of [
      ['playlist_songs', 'song_id', ''],
      ['library_song_artists', 'song_id', ''],
      ['play_events', 'song_id', ''],
      ['curation_flags', 'target_id', 'song'],
    ] as const) {
      const where = kind ? ` AND target_kind = '${kind}'` : '';
      expect(
        db.query(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?${where}`).get(b),
      ).toEqual({ c: 1 });
      expect(
        db.query(`SELECT COUNT(*) AS c FROM ${table} WHERE ${col} = ?${where}`).get(a),
      ).toEqual({ c: 0 });
    }
    // The cached track carries its old relPath, so it is dropped, never moved.
    expect(db.query('SELECT COUNT(*) AS c FROM scan_cache').get()).toEqual({ c: 0 });
  });

  it('is a no-op the second time', () => {
    const from = 'A/B/01 - X.opus';
    const to = 'A/B/2-01 - X.opus';
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at) VALUES (?, 'alb', 'X', 'A', 'art', ?, 1)`,
      [songId(from), from],
    );
    const carry = { fromId: songId(from), toId: songId(to), from, to };
    db.transaction(() => migrateSongIdentity(db, carry))();
    const again = db.transaction(() => migrateSongIdentity(db, carry))();
    expect(again.rowMoved).toBe(false);
    expect(db.query('SELECT id FROM library_songs').all()).toEqual([{ id: songId(to) }]);
  });
});

describe('stage, apply, resume, revert', () => {
  let dir: string;
  let music: string;
  let db: Database;
  const files = [
    'A/Album/01 - Intro.opus',
    'A/Album/01 - Intro (2).opus',
    'A/Album/02 - Song.opus',
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mdr-'));
    music = join(dir, 'music');
    mkdirSync(join(music, 'A/Album'), { recursive: true });
    db = new Database(':memory:');
    applySchema(db);
    const discs = [1, 2, 1];
    files.forEach((p, i) => {
      writeFileSync(join(music, p), `audio-${i}`);
      db.run(
        `INSERT INTO library_songs (id, album_id, title, artist, artist_id, track, disc, path, synced_at)
         VALUES (?, 'alb', ?, 'A', 'art', ?, ?, ?, 1)`,
        [songId(p), `t${i}`, i === 2 ? 2 : 1, discs[i]!, p],
      );
    });
    seedUser(db);
    files.forEach((p, i) =>
      db.run(
        `INSERT INTO playlist_songs (playlist_id, song_id, position, added_at) VALUES ('p', ?, ?, 1)`,
        [songId(p), i],
      ),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const rows = () =>
    db.query<RenameRow, []>('SELECT id, path, disc, track FROM library_songs').all();

  it('refuses to stage a missing source or an occupied target', () => {
    const plan = planMultiDiscRenames(rows(), reserved);
    rmSync(join(music, files[0]!));
    writeFileSync(join(music, 'A/Album/1-02 - Song.opus'), 'squatter');
    const staged = stageRenames(plan.renames, music);
    expect(staged.unresolved.map((u) => [u.from, u.state])).toEqual([
      ['A/Album/01 - Intro.opus', 'missing'],
      ['A/Album/02 - Song.opus', 'conflict'],
    ]);
    expect(() => applyRenames(db, music, staged, join(dir, 'j.jsonl'))).toThrow(/unresolved/);
    // Nothing moved.
    expect(existsSync(join(music, 'A/Album/01 - Intro (2).opus'))).toBe(true);
  });

  it('renames on disk, carries every id, journals every move, and a re-run does nothing', () => {
    const journal = join(dir, 'j.jsonl');
    const staged = stageRenames(planMultiDiscRenames(rows(), reserved).renames, music);
    const r = applyRenames(db, music, staged, journal);
    expect(r.applied).toBe(3);
    expect(readFileSync(join(music, 'A/Album/2-01 - Intro.opus'), 'utf8')).toBe('audio-1');
    expect(existsSync(join(music, 'A/Album/01 - Intro (2).opus'))).toBe(false);
    const ids = rows()
      .map((x) => x.id)
      .sort();
    const pl = db
      .query<{ song_id: string }, []>('SELECT song_id FROM playlist_songs')
      .all()
      .map((x) => x.song_id)
      .sort();
    expect(pl).toEqual(ids);
    expect(readFileSync(journal, 'utf8').trim().split('\n')).toHaveLength(6);

    const again = planMultiDiscRenames(rows(), reserved);
    expect(again.renames).toEqual([]);
    expect(again.alreadyDone).toBe(3);
  });

  it('resumes a crash between link and unlink, and one between unlink and the DB step', () => {
    const plan = planMultiDiscRenames(rows(), reserved);
    const [first, second] = plan.renames;
    linkSync(join(music, first!.from), join(music, first!.to)); // crash after link
    linkSync(join(music, second!.from), join(music, second!.to));
    rmSync(join(music, second!.from)); // crash after unlink, before the DB step

    const staged = stageRenames(planMultiDiscRenames(rows(), reserved).renames, music);
    expect(staged.ready.map((s) => s.state)).toEqual(['linked', 'moved', 'pending']);
    const r = applyRenames(db, music, staged, join(dir, 'j.jsonl'));
    expect(r.applied).toBe(3);
    expect(existsSync(join(music, first!.from))).toBe(false);
    expect(
      rows()
        .map((x) => x.path)
        .sort(),
    ).toEqual([
      'A/Album/1-01 - Intro.opus',
      'A/Album/1-02 - Song.opus',
      'A/Album/2-01 - Intro.opus',
    ]);
  });

  it('reverts from the journal back to the original names and ids', () => {
    const journal = join(dir, 'j.jsonl');
    applyRenames(
      db,
      music,
      stageRenames(planMultiDiscRenames(rows(), reserved).renames, music),
      journal,
    );
    const r = revertRenames(db, music, journal);
    expect(r.applied).toBe(3);
    expect(
      rows()
        .map((x) => x.path)
        .sort(),
    ).toEqual([...files].sort());
    expect(readFileSync(join(music, 'A/Album/01 - Intro (2).opus'), 'utf8')).toBe('audio-1');
    const pl = db.query<{ song_id: string }, []>('SELECT song_id FROM playlist_songs').all();
    expect(pl.map((x) => x.song_id).sort()).toEqual(files.map(songId).sort());
  });
});

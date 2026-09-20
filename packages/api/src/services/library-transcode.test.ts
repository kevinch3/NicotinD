/**
 * Tests for the existing-library lossless → Opus conversion, with focus on the
 * songId identity migration (playlist entries, acquisitions, starred carried
 * across the extension/id change). Generates real FLACs via ffmpeg + a real
 * in-memory DB; the apply-path tests skip when ffmpeg is absent (CI has it).
 */
import { describe, expect, it, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { transcodeLibraryToOpus } from './library-transcode.js';
import { songId } from './library-scanner.js';
import { ffmpegAvailable } from './transcode.js';
import { upsertGenreOverride } from './genre-overrides.js';

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
  makeAudio(musicDir, rel, title, 'flac');
}

function makeAudio(
  musicDir: string,
  rel: string,
  title: string,
  codec: 'flac' | 'alac' | 'aac',
): void {
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
      codec,
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

function seedSongRow(
  db: Database,
  rel: string,
  extra: { starred?: string; hidden?: number; size?: number; duration?: number } = {},
) {
  const id = songId(rel);
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, suffix, size, duration, starred, hidden, synced_at)
     VALUES (?, 'alb', 'Avril 14th', 'Aphex Twin', 'art', ?, 'flac', ?, ?, ?, ?, 1)`,
    [id, rel, extra.size ?? 1000, extra.duration ?? 120, extra.starred ?? null, extra.hidden ?? 0],
  );
  return id;
}

function overrideSong(db: Database, key: string, genres: string[]): void {
  upsertGenreOverride(db, {
    scope: 'song',
    key,
    genres,
    source: 'user',
    mbid: null,
    confidence: null,
    status: 'applied',
    note: null,
    mode: 'replace',
  });
}

const songOverrides = (db: Database) =>
  db
    .query<{ key: string; genres: string }, []>(
      `SELECT key, genres FROM library_genre_overrides WHERE scope = 'song'`,
    )
    .all();

describe('transcodeLibraryToOpus', () => {
  it('dry run reports candidates without touching disk or db', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'Aphex Twin/Drukqs/01 - Avril 14th.flac';
    mkdirSync(dirname(join(music, rel)), { recursive: true });
    await Bun.write(join(music, rel), 'x'); // dry-run only existsSync-checks
    seedSongRow(db, rel);

    const r = await transcodeLibraryToOpus(db, music, { apply: false, bitRate: 192 });
    expect(r.candidates).toBe(1);
    expect(r.converted).toBe(1); // would-convert count
    // Row unchanged (still flac).
    const row = db.query<{ suffix: string }, []>('SELECT suffix FROM library_songs').get();
    expect(row?.suffix).toBe('flac');
  });

  describe('dry-run bytesReclaimed', () => {
    it('reports the difference, not the whole original size', async () => {
      const music = tmpMusic();
      const db = new Database(':memory:');
      applySchema(db);
      const rel = 'Aphex Twin/Drukqs/01 - Avril 14th.flac';
      mkdirSync(dirname(join(music, rel)), { recursive: true });
      await Bun.write(join(music, rel), 'x');
      // 120 s at 192 kbps ≈ 2,880,000 bytes of Opus out of a 10 MB source.
      seedSongRow(db, rel, { size: 10_000_000, duration: 120 });

      const r = await transcodeLibraryToOpus(db, music, { apply: false, bitRate: 192 });

      // Before the fix this was the full 10,000,000 — it assumed the Opus file
      // would be zero bytes, so the figure the operator sizes a run against was
      // always too high by the size of every resulting file.
      expect(r.bytesReclaimed).toBe(10_000_000 - 120 * 192 * 125);
      expect(r.bytesReclaimed).toBeLessThan(10_000_000);
      expect(r.unestimated).toBe(0);
    });

    it('scales the estimate with the chosen bitrate', async () => {
      const music = tmpMusic();
      const db = new Database(':memory:');
      applySchema(db);
      const rel = 'Aphex Twin/Drukqs/01 - Avril 14th.flac';
      mkdirSync(dirname(join(music, rel)), { recursive: true });
      await Bun.write(join(music, rel), 'x');
      seedSongRow(db, rel, { size: 10_000_000, duration: 120 });

      const low = await transcodeLibraryToOpus(db, music, { apply: false, bitRate: 96 });
      const high = await transcodeLibraryToOpus(db, music, { apply: false, bitRate: 256 });
      // A smaller encode frees more; the old code reported the same either way.
      expect(low.bytesReclaimed).toBeGreaterThan(high.bytesReclaimed);
    });

    it('counts a file with no duration as unestimated rather than guessing', async () => {
      const music = tmpMusic();
      const db = new Database(':memory:');
      applySchema(db);
      const rel = 'Aphex Twin/Drukqs/01 - Avril 14th.flac';
      mkdirSync(dirname(join(music, rel)), { recursive: true });
      await Bun.write(join(music, rel), 'x');
      seedSongRow(db, rel, { size: 10_000_000, duration: 0 });

      const r = await transcodeLibraryToOpus(db, music, { apply: false, bitRate: 192 });

      // Under-report rather than over-report: a floor is recoverable, the old
      // over-estimate is what this fix exists to stop.
      expect(r.bytesReclaimed).toBe(0);
      expect(r.unestimated).toBe(1);
    });

    it.skipIf(!ffmpegAvailable())(
      'lands within a sane margin of the real apply figure',
      async () => {
        // Against a real encode rather than a seeded size, so the bound is
        // checked on the shape of file the pass actually meets.
        const music = tmpMusic();
        const db = new Database(':memory:');
        applySchema(db);
        const rel = 'Aphex Twin/Drukqs/01 - Avril 14th.flac';
        const abs = join(music, rel);
        makeFlac(music, rel, 'Avril 14th');
        const size = statSync(abs).size;
        // The fixture is a short generated FLAC; its real duration is what the
        // estimate has to work from.
        seedSongRow(db, rel, { size, duration: 1 });

        const dry = await transcodeLibraryToOpus(db, music, { apply: false, bitRate: 96 });

        expect(dry.unestimated).toBe(0);
        // The bound that matters, and the one the old code broke: a dry run can
        // never claim to free more than the file occupies. It used to claim
        // exactly that — the whole source size, every time.
        expect(dry.bytesReclaimed).toBeLessThan(size);

        // This one-second fixture is the honest edge case: Opus at 96 kbps costs
        // more than a second of silent FLAC, so there is no saving to report and
        // the pass says zero rather than inventing one.
        expect(dry.bytesReclaimed).toBe(0);
      },
    );
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
        .query<{ suffix: string; starred: string | null; hidden: number; path: string }, [string]>(
          'SELECT suffix, starred, hidden, path FROM library_songs WHERE id = ?',
        )
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
        .query<{ relative_path: string; source_ref: string }, []>(
          'SELECT relative_path, source_ref FROM acquisitions',
        )
        .all();
      expect(acqs).toHaveLength(1);
      expect(acqs[0]?.relative_path).toBe(newRel);
      expect(acqs[0]?.source_ref).toBe('opus-peer');
    },
  );

  it.skipIf(!ffmpegAvailable())(
    // #856: a lossless→Opus re-encode re-mints the song id, and this was the one
    // curated table the identity migration never carried across.
    'migrates a curator song-scope genre override onto the new id',
    async () => {
      const music = tmpMusic();
      const db = new Database(':memory:');
      applySchema(db);

      const rel = 'Aphex Twin/Drukqs/01 - Avril 14th.flac';
      makeFlac(music, rel, 'Avril 14th');
      const oldId = seedSongRow(db, rel);
      overrideSong(db, oldId, ['Ambient']);

      const r = await transcodeLibraryToOpus(db, music, { apply: true, bitRate: 96 });
      expect(r.converted).toBe(1);
      expect(r.failed).toBe(0);

      const newId = songId('Aphex Twin/Drukqs/01 - Avril 14th.opus');
      expect(songOverrides(db)).toEqual([{ key: newId, genres: 'Ambient' }]);
    },
  );

  it.skipIf(!ffmpegAvailable())(
    'drops the stale override when the opus row already carries its own',
    async () => {
      const music = tmpMusic();
      const db = new Database(':memory:');
      applySchema(db);

      const rel = 'Aphex Twin/Drukqs/01 - Avril 14th.flac';
      makeFlac(music, rel, 'Avril 14th');
      const oldId = seedSongRow(db, rel);
      const newId = songId('Aphex Twin/Drukqs/01 - Avril 14th.opus');
      // (scope, key) is the primary key — a plain UPDATE would abort the pass.
      overrideSong(db, newId, ['Techno']);
      overrideSong(db, oldId, ['Ambient']);

      const r = await transcodeLibraryToOpus(db, music, { apply: true, bitRate: 96 });
      expect(r.converted).toBe(1);
      expect(r.failed).toBe(0);

      // The opus row's own decision wins; the dead lossless row is not left behind.
      expect(songOverrides(db)).toEqual([{ key: newId, genres: 'Techno' }]);
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
    const r = await transcodeLibraryToOpus(db, music, { apply: true, bitRate: 192 });
    expect(r.candidates).toBe(0);
    expect(r.converted).toBe(0);
  });

  it.skipIf(!ffmpegAvailable())(
    'treats ALAC .m4a rows as lossless candidates (extension alone misses them)',
    async () => {
      const music = tmpMusic();
      const db = new Database(':memory:');
      applySchema(db);
      const alacRel = 'Matias Aguayo/Support Alien Invasion/09 - Spread This Number.m4a';
      const aacRel = 'Matias Aguayo/Support Alien Invasion/01 - Rollerskate.m4a';
      makeAudio(music, alacRel, 'Spread This Number', 'alac');
      makeAudio(music, aacRel, 'Rollerskate', 'aac');
      seedSongRow(db, alacRel);
      seedSongRow(db, aacRel);
      db.run(`UPDATE library_songs SET suffix = 'm4a'`);

      const r = await transcodeLibraryToOpus(db, music, { apply: true, bitRate: 96 });
      // Only the ALAC file is a candidate; the lossy AAC one is untouched.
      expect(r.candidates).toBe(1);
      expect(r.converted).toBe(1);
      expect(existsSync(join(music, alacRel))).toBe(false);
      expect(existsSync(join(music, alacRel.replace(/\.m4a$/, '.opus')))).toBe(true);
      expect(existsSync(join(music, aacRel))).toBe(true);
    },
  );
});

describe('disk headroom preflight', () => {
  const fullDisk = () => ({ bsize: 4096, blocks: 100, bavail: 0 });
  const roomyDisk = () => ({ bsize: 4096, blocks: 1e9, bavail: 1e9 });
  const unprobeable = () => {
    throw new Error('EPERM: container mount does not implement statfs');
  };

  async function oneCandidate() {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'Aphex Twin/Drukqs/01 - Avril 14th.flac';
    mkdirSync(dirname(join(music, rel)), { recursive: true });
    await Bun.write(join(music, rel), 'x');
    seedSongRow(db, rel, { size: 5_000_000, duration: 120 });
    return { music, db };
  }

  // The two apply-path cases need ffmpeg, and not because they test it: the
  // pass rejects on a missing binary BEFORE it reaches the preflight, so
  // without it these assert the wrong error and pass or fail for the wrong
  // reason. The `ci` job has no ffmpeg; the e2e job does.
  it.skipIf(!ffmpegAvailable())('refuses to start when the disk is full', async () => {
    const { music, db } = await oneCandidate();
    await expect(
      transcodeLibraryToOpus(db, music, { apply: true, bitRate: 96, statfs: fullDisk }),
    ).rejects.toThrow(/Not enough free space/);
  });

  it('PROCEEDS when the filesystem cannot be probed', async () => {
    // "Unknown is not full." A preflight that refuses to run on a mount it
    // cannot stat is worse than no preflight — that failure shape once blocked
    // an upgrade, which is why every probe here fails open.
    const { music, db } = await oneCandidate();
    const r = await transcodeLibraryToOpus(db, music, {
      apply: false,
      bitRate: 96,
      statfs: unprobeable,
    });
    expect(r.candidates).toBe(1);
  });

  it('does not preflight a dry run', async () => {
    // A dry run writes nothing, so a full disk must not stop it — that is
    // exactly when an operator needs the sizing report most.
    const { music, db } = await oneCandidate();
    const r = await transcodeLibraryToOpus(db, music, {
      apply: false,
      bitRate: 96,
      statfs: fullDisk,
    });
    expect(r.candidates).toBe(1);
    expect(r.converted).toBe(1);
  });

  it.skipIf(!ffmpegAvailable())('does not preflight when there is nothing to convert', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const r = await transcodeLibraryToOpus(db, music, {
      apply: true,
      bitRate: 96,
      statfs: fullDisk,
    });
    expect(r.candidates).toBe(0);
  });

  it('passes when there is room', async () => {
    const { music, db } = await oneCandidate();
    const r = await transcodeLibraryToOpus(db, music, {
      apply: false,
      bitRate: 96,
      statfs: roomyDisk,
    });
    expect(r.candidates).toBe(1);
  });
});

// The WHOLE block is guarded, not the individual cases. Every test here uses
// `apply: true`, and `transcodeLibraryToOpus` rejects on a missing ffmpeg
// BEFORE it reaches anything under test — so on the `ci` job, which has no
// ffmpeg, an unguarded case asserts the wrong error and fails for a reason
// that has nothing to do with quarantine. Guarding the describe means a case
// added later inherits it rather than repeating the mistake.
describe.skipIf(!ffmpegAvailable())('keeping originals (back up before transcoding)', () => {
  const roomy = () => ({ bsize: 4096, blocks: 1e9, bavail: 1e9 });

  it.skipIf(!ffmpegAvailable())(
    'moves the original into the run instead of deleting it',
    async () => {
      const music = tmpMusic();
      const data = tmpMusic();
      const db = new Database(':memory:');
      applySchema(db);
      const rel = 'Aphex Twin/Drukqs/01 - Avril 14th.flac';
      makeFlac(music, rel, 'Avril 14th');
      seedSongRow(db, rel, { size: statSync(join(music, rel)).size, duration: 1 });

      const r = await transcodeLibraryToOpus(db, music, {
        apply: true,
        bitRate: 96,
        dataDir: data,
        statfs: roomy,
      });

      expect(r.converted).toBe(1);
      expect(existsSync(join(music, rel))).toBe(false); // gone from the library
      expect(r.quarantineRun).toBeTruthy();
      // ...but still on disk, under its library-relative path.
      expect(existsSync(join(r.quarantineRun!, rel))).toBe(true);
    },
  );

  it('deletes the original when no dataDir is given', async () => {
    // The download path's contract, unchanged: a just-fetched original is one
    // re-download away, and quarantining every download would fill the disk.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'Aphex Twin/Drukqs/01 - Avril 14th.flac';
    makeFlac(music, rel, 'Avril 14th');
    seedSongRow(db, rel, { size: statSync(join(music, rel)).size, duration: 1 });

    const r = await transcodeLibraryToOpus(db, music, { apply: true, bitRate: 96, statfs: roomy });

    expect(r.converted).toBe(1);
    expect(r.quarantineRun).toBeUndefined();
    expect(existsSync(join(music, rel))).toBe(false);
  });

  it('leaves no empty run behind when there is nothing to convert', async () => {
    const music = tmpMusic();
    const data = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const r = await transcodeLibraryToOpus(db, music, {
      apply: true,
      bitRate: 96,
      dataDir: data,
      statfs: roomy,
    });
    expect(r.candidates).toBe(0);
    expect(r.quarantineRun).toBeUndefined();
    expect(existsSync(join(data, 'quarantine'))).toBe(false);
  });

  it('requires room for the WHOLE output when originals are kept', async () => {
    // The arithmetic inverts: normally each output replaces its source and the
    // run ends smaller, so one file's worth of headroom is enough. Keeping the
    // originals frees nothing, so the requirement is every output at once.
    const music = tmpMusic();
    const data = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    for (let i = 1; i <= 3; i++) {
      const rel = `A/Album/0${i} - T.flac`;
      mkdirSync(dirname(join(music, rel)), { recursive: true });
      await Bun.write(join(music, rel), 'x');
      seedSongRow(db, rel, { size: 5_000_000, duration: 600 });
    }
    // Room for one 600 s @ 96 kbps output (7.2 MB) plus the margin, but not
    // three. Without a dataDir this passes; with one it must not.
    const tight = () => ({ bsize: 1, blocks: 1e9, bavail: 520 * 1024 * 1024 });

    await expect(
      transcodeLibraryToOpus(db, music, { apply: true, bitRate: 96, dataDir: data, statfs: tight }),
    ).rejects.toThrow(/Not enough free space/);
  });
});

describe.skipIf(!ffmpegAvailable())('concurrency: the three-phase split', () => {
  /** One album of `n` tracks, seeded as stale lossless rows. */
  function seedAlbum(db: Database, music: string, n: number): string[] {
    const rels: string[] = [];
    for (let i = 1; i <= n; i++) {
      const rel = `Aphex Twin/Drukqs/${String(i).padStart(2, '0')} - Track ${i}.flac`;
      makeFlac(music, rel, `Track ${i}`);
      seedSongRow(db, rel);
      rels.push(rel);
    }
    return rels;
  }

  it('keeps the album song count right across a pooled batch', async () => {
    // The reason the migration phase stays serial. `scanPaths` reads whole-DB
    // state outside a transaction and recomputes album aggregates from it, so
    // two concurrent calls lose counts for any album with two files converted
    // at once. Six tracks is more than the pool depth, so the pool is really
    // exercised — a serial run would pass this even with the bug.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    seedAlbum(db, music, 6);

    const r = await transcodeLibraryToOpus(db, music, { apply: true, bitRate: 96 });

    expect(r.converted).toBe(6);
    expect(r.failed).toBe(0);
    const album = db
      .query<{ song_count: number }, []>(
        `SELECT song_count FROM library_albums WHERE name = 'Drukqs'`,
      )
      .get();
    expect(album?.song_count).toBe(6);
    expect(db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM library_songs`).get()?.n).toBe(6);
  });

  it('converts every sibling when one file in the batch fails', async () => {
    // `mapPool` is `Promise.all` underneath: one throw rejects it and every
    // sibling result is lost. The pooled phase therefore catches internally
    // and returns an outcome, and this is what proves it.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    seedAlbum(db, music, 5);
    const broken = 'Aphex Twin/Drukqs/99 - Broken.flac';
    await Bun.write(join(music, broken), 'this is not a flac');
    seedSongRow(db, broken);

    const r = await transcodeLibraryToOpus(db, music, { apply: true, bitRate: 96 });

    expect(r.converted).toBe(5);
    expect(r.failed).toBe(1);
    expect(r.errorSample).toBeTruthy();
    // The failure kept its original, and every sibling really moved.
    expect(existsSync(join(music, broken))).toBe(true);
    expect(existsSync(join(music, 'Aphex Twin/Drukqs/01 - Track 1.opus'))).toBe(true);
  });

  it('emits a progress snapshot per file, not a live reference', async () => {
    // `result` is mutated for the whole pass. Handing the caller the object
    // itself means every event it kept shows the FINAL counters, so a progress
    // bar built from them jumps from nothing to done.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    seedAlbum(db, music, 5);

    const seen: Array<{ visited: number; converted: number }> = [];
    await transcodeLibraryToOpus(db, music, {
      apply: true,
      bitRate: 96,
      onProgress: (p) => seen.push({ visited: p.visited, converted: p.result.converted }),
    });

    expect(seen.length).toBe(5);
    expect(seen.map((s) => s.visited)).toEqual([1, 2, 3, 4, 5]);
    expect(seen[0]!.converted).toBeLessThan(seen[seen.length - 1]!.converted);
  });

  it('never leaves an encoded file with no library row when stopped', async () => {
    // `shouldStop` is checked between batches, never between an encode and its
    // migration — stopping there would strand an .opus on disk that nothing
    // points at, with its original already gone.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    seedAlbum(db, music, 6);

    const r = await transcodeLibraryToOpus(db, music, {
      apply: true,
      bitRate: 96,
      shouldStop: () => true,
    });

    expect(r.stopped).toBe(true);
    expect(r.converted).toBe(0);
    const opusOnDisk = readdirSync(join(music, 'Aphex Twin/Drukqs')).filter((n) =>
      n.endsWith('.opus'),
    );
    expect(opusOnDisk).toEqual([]);
  });
});

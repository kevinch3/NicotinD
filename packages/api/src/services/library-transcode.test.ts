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
import { transcodeLibraryToFormat } from './library-transcode.js';
import { isLosslessFile } from './post-download-transcode.js';
import { songId } from './library-scanner.js';
import { ffmpegAvailable } from './transcode.js';
import { upsertGenreOverride } from './genre-overrides.js';
import { createQuarantineRun, listQuarantineRuns } from './transcode-quarantine.js';

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
  extra: {
    starred?: string;
    hidden?: number;
    size?: number;
    duration?: number;
    suffix?: string;
    bitRate?: number;
  } = {},
) {
  const id = songId(rel);
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, suffix, size, duration, bit_rate, starred, hidden, synced_at)
     VALUES (?, 'alb', 'Avril 14th', 'Aphex Twin', 'art', ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      id,
      rel,
      extra.suffix ?? 'flac',
      extra.size ?? 1000,
      extra.duration ?? 120,
      extra.bitRate ?? 0,
      extra.starred ?? null,
      extra.hidden ?? 0,
    ],
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

describe('transcodeLibraryToFormat', () => {
  it('dry run reports candidates without touching disk or db', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'Aphex Twin/Drukqs/01 - Avril 14th.flac';
    mkdirSync(dirname(join(music, rel)), { recursive: true });
    await Bun.write(join(music, rel), 'x'); // dry-run only existsSync-checks
    seedSongRow(db, rel);

    const r = await transcodeLibraryToFormat(db, music, { apply: false, bitRate: 192 });
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

      const r = await transcodeLibraryToFormat(db, music, { apply: false, bitRate: 192 });

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

      const low = await transcodeLibraryToFormat(db, music, { apply: false, bitRate: 96 });
      const high = await transcodeLibraryToFormat(db, music, { apply: false, bitRate: 256 });
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

      const r = await transcodeLibraryToFormat(db, music, { apply: false, bitRate: 192 });

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

        const dry = await transcodeLibraryToFormat(db, music, { apply: false, bitRate: 96 });

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

      const r = await transcodeLibraryToFormat(db, music, { apply: true, bitRate: 96 });
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

      const r = await transcodeLibraryToFormat(db, music, { apply: true, bitRate: 96 });
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

      const r = await transcodeLibraryToFormat(db, music, { apply: true, bitRate: 96 });
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

      const r = await transcodeLibraryToFormat(db, music, { apply: true, bitRate: 96 });
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
    const r = await transcodeLibraryToFormat(db, music, { apply: true, bitRate: 192 });
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

      const r = await transcodeLibraryToFormat(db, music, { apply: true, bitRate: 96 });
      // Only the ALAC file is a candidate; the lossy AAC one is untouched.
      expect(r.candidates).toBe(1);
      expect(r.converted).toBe(1);
      expect(existsSync(join(music, alacRel))).toBe(false);
      expect(existsSync(join(music, alacRel.replace(/\.m4a$/, '.opus')))).toBe(true);
      expect(existsSync(join(music, aacRel))).toBe(true);
    },
  );

  it.skipIf(!ffmpegAvailable())(
    'treats ALAC .m4a rows as lossless candidates when the target is aac too (#1286)',
    async () => {
      // The bug this guards: aac's own ext is 'm4a', so the "already the
      // target" shortcut used to match EVERY .m4a row — ALAC included —
      // before a codec probe ever ran, permanently skipping ALAC files
      // instead of converting them.
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

      const r = await transcodeLibraryToFormat(db, music, {
        apply: true,
        bitRate: 96,
        format: 'aac',
      });
      // Only the ALAC file is a candidate; the already-AAC one is a no-op skip.
      expect(r.candidates).toBe(1);
      expect(r.converted).toBe(1);
      // Same extension in and out, so the path does not change — but the
      // bytes at it must now be the lossy encode, not the original ALAC.
      expect(existsSync(join(music, alacRel))).toBe(true);
      expect(await isLosslessFile(join(music, alacRel))).toBe(false);
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
      transcodeLibraryToFormat(db, music, { apply: true, bitRate: 96, statfs: fullDisk }),
    ).rejects.toThrow(/Not enough free space/);
  });

  it('PROCEEDS when the filesystem cannot be probed', async () => {
    // "Unknown is not full." A preflight that refuses to run on a mount it
    // cannot stat is worse than no preflight — that failure shape once blocked
    // an upgrade, which is why every probe here fails open.
    const { music, db } = await oneCandidate();
    const r = await transcodeLibraryToFormat(db, music, {
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
    const r = await transcodeLibraryToFormat(db, music, {
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
    const r = await transcodeLibraryToFormat(db, music, {
      apply: true,
      bitRate: 96,
      statfs: fullDisk,
    });
    expect(r.candidates).toBe(0);
  });

  it('passes when there is room', async () => {
    const { music, db } = await oneCandidate();
    const r = await transcodeLibraryToFormat(db, music, {
      apply: false,
      bitRate: 96,
      statfs: roomyDisk,
    });
    expect(r.candidates).toBe(1);
  });
});

// The WHOLE block is guarded, not the individual cases. Every test here uses
// `apply: true`, and `transcodeLibraryToFormat` rejects on a missing ffmpeg
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

      const r = await transcodeLibraryToFormat(db, music, {
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

  it.skipIf(!ffmpegAvailable())(
    "never prunes an earlier conversion's quarantine run (#1260)",
    async () => {
      // A library converted in batches used to lose its oldest runs' originals
      // the moment a later batch finished: the pass pruned to three.
      const music = tmpMusic();
      const data = tmpMusic();
      for (let day = 1; day <= 4; day++) createQuarantineRun(data, new Date(2026, 8, day));
      const db = new Database(':memory:');
      applySchema(db);
      const rel = 'Aphex Twin/Drukqs/01 - Avril 14th.flac';
      makeFlac(music, rel, 'Avril 14th');
      seedSongRow(db, rel, { size: statSync(join(music, rel)).size, duration: 1 });

      const r = await transcodeLibraryToFormat(db, music, {
        apply: true,
        bitRate: 96,
        dataDir: data,
        statfs: roomy,
      });

      expect(r.converted).toBe(1);
      expect(listQuarantineRuns(data)).toHaveLength(5);
      expect(r.quarantineRunsHeld).toBe(5);
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

    const r = await transcodeLibraryToFormat(db, music, {
      apply: true,
      bitRate: 96,
      statfs: roomy,
    });

    expect(r.converted).toBe(1);
    expect(r.quarantineRun).toBeUndefined();
    expect(existsSync(join(music, rel))).toBe(false);
  });

  it('leaves no empty run behind when there is nothing to convert', async () => {
    const music = tmpMusic();
    const data = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const r = await transcodeLibraryToFormat(db, music, {
      apply: true,
      bitRate: 96,
      dataDir: data,
      statfs: roomy,
    });
    expect(r.candidates).toBe(0);
    expect(r.quarantineRun).toBeUndefined();
    expect(existsSync(join(data, 'quarantine'))).toBe(false);
  });

  it.skipIf(!ffmpegAvailable())(
    'quarantines the original ALAC when converting it to aac, not the new encode (#1286)',
    async () => {
      // The trap the candidate-selection fix exposes: destPath equals absPath
      // whenever the source is already `.m4a` and the target is too, so the
      // rename that promotes the new encode would silently overwrite the
      // original BEFORE the "deal with the original" step ever ran — quarantine
      // skipped entirely, generation loss unrecoverable. This proves the
      // ORIGINAL lossless bytes land in the quarantine run, not the new lossy
      // ones the library path now holds.
      const music = tmpMusic();
      const data = tmpMusic();
      const db = new Database(':memory:');
      applySchema(db);
      const rel = 'Matias Aguayo/Support Alien Invasion/09 - Spread This Number.m4a';
      makeAudio(music, rel, 'Spread This Number', 'alac');
      seedSongRow(db, rel, { suffix: 'm4a' });

      const r = await transcodeLibraryToFormat(db, music, {
        apply: true,
        bitRate: 96,
        format: 'aac',
        dataDir: data,
        statfs: roomy,
      });

      expect(r.converted).toBe(1);
      expect(r.quarantineRun).toBeTruthy();
      // The live library path now holds the new, lossy encode...
      expect(existsSync(join(music, rel))).toBe(true);
      expect(await isLosslessFile(join(music, rel))).toBe(false);
      // ...and the quarantine copy is the untouched, still-lossless original.
      const quarantined = join(r.quarantineRun!, rel);
      expect(existsSync(quarantined)).toBe(true);
      expect(await isLosslessFile(quarantined)).toBe(true);
    },
  );

  it('requires room for every ORIGINAL when they are kept', async () => {
    // This used to assert the whole projected OUTPUT, on musicDir. Both were
    // wrong: the originals are what accumulate, they are roughly twice the size
    // of the output, and they land on the quarantine filesystem — which on kpc
    // is a different, much smaller disk than the library.
    const music = tmpMusic();
    const data = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const MB = 1024 * 1024;
    for (let i = 1; i <= 10; i++) {
      const rel = `A/Album/${String(i).padStart(2, '0')} - T.flac`;
      mkdirSync(dirname(join(music, rel)), { recursive: true });
      await Bun.write(join(music, rel), 'x');
      seedSongRow(db, rel, { size: 50 * MB, duration: 600 });
    }
    // 800 MB free. Keeping originals needs 500 MB of backups + 500 MB margin =
    // 1000 MB, so it must refuse. Without a dataDir the requirement is one
    // encode per worker (50 x 4) + margin = 700 MB, so it must proceed.
    const eightHundredMB = () => ({ bsize: 1, blocks: 1e9, bavail: 800 * MB });

    await expect(
      transcodeLibraryToFormat(db, music, {
        apply: true,
        bitRate: 96,
        dataDir: data,
        statfs: eightHundredMB,
      }),
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

    const r = await transcodeLibraryToFormat(db, music, { apply: true, bitRate: 96 });

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

    const r = await transcodeLibraryToFormat(db, music, { apply: true, bitRate: 96 });

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
    await transcodeLibraryToFormat(db, music, {
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

    const r = await transcodeLibraryToFormat(db, music, {
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

describe('source-adaptive bitrate', () => {
  it('gives every candidate the top rate today, because every candidate is lossless', async () => {
    // Honest about what this currently proves. The pass selects lossless files
    // only, and lossless takes the ladder's losslessKbps without consulting the
    // ladder — so the ladder is wired but INERT until the predicate extends to
    // the 13,576 mp3s. Its own unit tests cover the buckets; this covers the
    // wiring, and will start distinguishing rates the moment the predicate
    // grows. Written this way so it cannot quietly pass for the wrong reason.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'A/Album/01 - Song.flac';
    mkdirSync(dirname(join(music, rel)), { recursive: true });
    await Bun.write(join(music, rel), 'x');
    seedSongRow(db, rel, { size: 10_000_000, duration: 120, bitRate: 96 });

    const adaptive = await transcodeLibraryToFormat(db, music, { apply: false });
    const at128 = await transcodeLibraryToFormat(db, music, { apply: false, bitRate: 128 });
    const at64 = await transcodeLibraryToFormat(db, music, { apply: false, bitRate: 64 });

    // Adaptive agrees with a pinned 128 and differs from a pinned 64, which is
    // what "took the top rate" means in terms this pass can observe.
    expect(adaptive.bytesReclaimed).toBe(at128.bytesReclaimed);
    expect(adaptive.bytesReclaimed).not.toBe(at64.bytesReclaimed);
  });

  it('treats an unprobed bitrate as top rate, never as a quiet source', async () => {
    // `bit_rate = 0` is probe failure. Reading it as "under 128, encode at 64"
    // would crush exactly the files we know least about.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'A/Album/01 - Unknown.flac';
    mkdirSync(dirname(join(music, rel)), { recursive: true });
    await Bun.write(join(music, rel), 'x');
    seedSongRow(db, rel, { size: 10_000_000, duration: 120, bitRate: 0 });

    const r = await transcodeLibraryToFormat(db, music, { apply: false });
    const at128 = await transcodeLibraryToFormat(db, music, { apply: false, bitRate: 128 });

    expect(r.bytesReclaimed).toBe(at128.bytesReclaimed);
  });
});

describe('conversion scope', () => {
  async function seedMixed(db: Database, music: string): Promise<void> {
    for (const [rel, suffix] of [
      ['A/Al/01 - Lossless.flac', 'flac'],
      ['A/Al/02 - Lossy.mp3', 'mp3'],
      ['A/Al/03 - Windows.wma', 'wma'],
      ['A/Al/04 - Vorbis.ogg', 'ogg'],
      ['A/Al/05 - Already.opus', 'opus'],
    ] as const) {
      mkdirSync(dirname(join(music, rel)), { recursive: true });
      await Bun.write(join(music, rel), 'x');
      seedSongRow(db, rel, { suffix });
    }
  }

  it('takes only lossless by default', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    await seedMixed(db, music);

    const r = await transcodeLibraryToFormat(db, music, { apply: false });

    expect(r.candidates).toBe(1); // the flac
  });

  it('takes every non-Opus file under scope=all', async () => {
    // What "convert all 13,864" means: 13,576 mp3 + 238 m4a + 44 ogg + 6 wma
    // + 3 flac. The wma matter because no current path can even tag them.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    await seedMixed(db, music);

    const r = await transcodeLibraryToFormat(db, music, { apply: false, scope: 'all' });

    expect(r.candidates).toBe(4); // flac, mp3, wma, ogg — not the opus
  });

  it('never re-encodes a file that is already Opus', async () => {
    // The one thing this pass must not do: Opus to Opus is pure generation
    // loss for zero gain, and at `scope: 'all'` the predicate is wide enough
    // to have swept it in.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    await seedMixed(db, music);

    for (const scope of ['lossless', 'all'] as const) {
      const r = await transcodeLibraryToFormat(db, music, { apply: false, scope });
      expect(r.candidates).toBeLessThan(5);
    }
    // Explicitly: the opus row is absent from both candidate sets.
    const all = await transcodeLibraryToFormat(db, music, { apply: false, scope: 'all' });
    expect(all.candidates).toBe(4);
  });

  it('skips an Opus row whose suffix column disagrees with its path', async () => {
    // Belt and braces: the scanner writes `suffix`, but a mis-scanned or
    // hand-edited row must not get the file re-encoded on the strength of a
    // stale column.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'A/Al/01 - Mislabelled.opus';
    mkdirSync(dirname(join(music, rel)), { recursive: true });
    await Bun.write(join(music, rel), 'x');
    seedSongRow(db, rel, { suffix: 'mp3' }); // wrong on purpose

    const r = await transcodeLibraryToFormat(db, music, { apply: false, scope: 'all' });

    expect(r.candidates).toBe(0);
  });
});

describe('the bitrate ladder, now that lossy files are in scope', () => {
  it('gives a 128k source a different rate than a 320k one', async () => {
    // Closes the loop on the ladder shipping inert: under `scope: 'all'` the
    // pass finally sees lossy files, so the buckets actually separate. The
    // reclaim estimate is the observable — same source size, different target.
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    for (const [rel, bitRate] of [
      ['A/Al/01 - Low.mp3', 128],
      ['A/Al/02 - High.mp3', 320],
    ] as const) {
      mkdirSync(dirname(join(music, rel)), { recursive: true });
      await Bun.write(join(music, rel), 'x');
      seedSongRow(db, rel, { suffix: 'mp3', size: 10_000_000, duration: 120, bitRate });
    }

    const low = await transcodeLibraryToFormat(db, music, {
      apply: false,
      scope: 'all',
      limit: 1,
    });
    const both = await transcodeLibraryToFormat(db, music, { apply: false, scope: 'all' });

    // 120 s at 96k is 1.44 MB; at 128k it is 1.92 MB. Two files at one rate
    // would reclaim exactly twice the first; they do not.
    expect(both.candidates).toBe(2);
    expect(both.bytesReclaimed).not.toBe(low.bytesReclaimed * 2);
  });

  it('still gives an unprobed lossy file the safe top rate', async () => {
    const music = tmpMusic();
    const db = new Database(':memory:');
    applySchema(db);
    const rel = 'A/Al/01 - Unknown.mp3';
    mkdirSync(dirname(join(music, rel)), { recursive: true });
    await Bun.write(join(music, rel), 'x');
    seedSongRow(db, rel, { suffix: 'mp3', size: 10_000_000, duration: 120, bitRate: 0 });

    const adaptive = await transcodeLibraryToFormat(db, music, { apply: false, scope: 'all' });
    const at128 = await transcodeLibraryToFormat(db, music, {
      apply: false,
      scope: 'all',
      bitRate: 128,
    });

    expect(adaptive.bytesReclaimed).toBe(at128.bytesReclaimed);
  });
});

// Guarded like every other apply-path describe here: `transcodeLibraryToFormat`
// throws "ffmpeg is required" BEFORE it reaches the preflight, so on the `ci`
// job (no ffmpeg) these would fail on the wrong error rather than assert the
// disk logic. The `e2e` job has ffmpeg and is what actually runs them.
describe.skipIf(!ffmpegAvailable())(
  'the preflight must probe the filesystem the originals land on',
  () => {
    const GiB = 1024 ** 3;

    /** Real dirs, so a failure is the preflight and not an mkdir permission error. */
    async function bigLibrary(sizeEach: number, count: number) {
      const music = tmpMusic();
      const data = tmpMusic(); // a second temp root, standing in for dataDir
      const db = new Database(':memory:');
      applySchema(db);
      for (let i = 1; i <= count; i++) {
        const rel = `A/Al/${String(i).padStart(3, '0')} - Track.flac`;
        mkdirSync(dirname(join(music, rel)), { recursive: true });
        await Bun.write(join(music, rel), 'x');
        seedSongRow(db, rel, { size: sizeEach, duration: 240 });
      }
      return { music, data, db };
    }

    /** kpc's real shape: roomy library disk, tight root holding dataDir. */
    const disks = (musicDir: string, musicGiB: number, dataGiB: number) => (path: string) =>
      path === musicDir
        ? { bsize: 4096, blocks: 1e9, bavail: (musicGiB * GiB) / 4096 }
        : { bsize: 4096, blocks: 1e9, bavail: (dataGiB * GiB) / 4096 };

    it('refuses when the quarantine disk is too small, even though musicDir is roomy', async () => {
      // The exact prod shape, and the case a single-filesystem check passes.
      // 10 originals x 8 GiB = 80 GiB of backups onto a 71 GiB root, while the
      // library disk being probed has 743 GiB and is getting EMPTIER.
      const { music, data, db } = await bigLibrary(8 * GiB, 10);

      await expect(
        transcodeLibraryToFormat(db, music, {
          apply: true,
          dataDir: data,
          statfs: disks(music, 743, 71),
        }),
      ).rejects.toThrow(/Not enough free space/);
    });

    it('names the filesystem that is short, not always musicDir', async () => {
      const { music, data, db } = await bigLibrary(8 * GiB, 10);

      await expect(
        transcodeLibraryToFormat(db, music, {
          apply: true,
          dataDir: data,
          statfs: disks(music, 743, 71),
        }),
      ).rejects.toThrow(new RegExp(data.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    it('sizes the quarantine side by ORIGINAL bytes, not projected output', async () => {
      // Opus at 128k for 240 s is ~3.8 MB against an 80 MB source, so sizing the
      // check by the output would under-ask by ~20x and let the run start.
      const { music, data, db } = await bigLibrary(80 * 1024 * 1024, 200); // ~15.6 GiB
      await expect(
        transcodeLibraryToFormat(db, music, {
          apply: true,
          dataDir: data,
          statfs: disks(music, 743, 10), // 10 GiB is short for 15.6, roomy for the output
        }),
      ).rejects.toThrow(/Not enough free space/);
    });

    it('proceeds when the quarantine disk genuinely has room', async () => {
      const { music, data, db } = await bigLibrary(1024 * 1024, 5);

      const r = await transcodeLibraryToFormat(db, music, {
        apply: false, // preflight is apply-only; this asserts the dry path is unaffected
        dataDir: data,
        statfs: disks(music, 743, 743),
      });

      expect(r.candidates).toBe(5);
    });
  },
);

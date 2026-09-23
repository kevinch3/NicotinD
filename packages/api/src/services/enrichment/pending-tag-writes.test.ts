import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProcessingTaskId } from '@nicotind/core';
import { applySchema } from '../../db.js';
import { getTask, type EnrichmentContext } from './tasks.js';
import {
  countPendingTagWrites,
  enqueueTagWrite,
  flushPendingTagWrites,
  type FlushTags,
} from './pending-tag-writes.js';
import { readAudioTags, writeAudioTags } from '../audio-tags.js';
import { ffmpegAvailable } from '../transcode.js';
import { setProcessingSettings } from '../processing-settings.js';
import { LibraryProcessingService } from '../library-processing.service.js';

let db: Database;
let dir: string;

function seedSong(id: string, path = `Artist/Album/${id}.opus`): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, landed_at, synced_at)
     VALUES (?, 'alb', ?, 'Artist', 'art', 0, ?, 10, 320, 'opus', 'audio/opus', '2024-01-01', 1, 1)`,
    [id, `T-${id}`, path],
  );
}

/** Fake analyzers; every tag write goes through `writeTags`, recorded. */
function ctx(
  writes: Array<{ abs: string; tags: FlushTags }>,
  overrides: Partial<EnrichmentContext> = {},
): EnrichmentContext {
  return {
    musicDir: dir,
    coverCacheDir: join(dir, 'cover-cache'),
    lidarr: {} as never,
    concurrency: 2,
    ffmpegAvailable: () => true,
    readTags: async () => ({}),
    writeTags: async (abs, tags) => (writes.push({ abs, tags }), true),
    deferTagWrites: true,
    analyzeBpm: async () => 128,
    analyzeRhythm: null,
    analyzeKey: async () => 'A minor',
    analyzeLoudness: async () => ({ loudness: -9.5, energy: 0.7 }),
    analyzeAudioFeatures: null,
    audioFeaturesAvailable: () => false,
    analyzeDescriptors: null,
    descriptorsAvailable: () => false,
    lookupGenre: async () => 'Rock',
    lookupArtistImageSpotify: async () => null,
    lookupArtistImageDiscogs: null,
    lookupArtistInfo: null,
    lookupGenreForRelease: null,
    resolveArtistIdentity: null,
    lookupPopularity: async () => new Map(),
    lookupArtistOrigin: null,
    lookupArtistReleaseGroups: null,
    fileExists: () => true,
    ...overrides,
  };
}

async function runTasks(
  c: EnrichmentContext,
  ids: readonly ProcessingTaskId[] = ['bpm', 'key', 'energy', 'genre'],
) {
  for (const id of ids) await getTask(id)!.run(db, c, 25);
}

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  dir = mkdtempSync(join(tmpdir(), 'nd-pending-tags-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('coalesced enrichment tag writes (#1311)', () => {
  it('four tasks on one song → no write during the tasks, one merged write at flush', async () => {
    seedSong('a');
    const writes: Array<{ abs: string; tags: FlushTags }> = [];
    const c = ctx(writes);
    await runTasks(c);
    expect(writes).toHaveLength(0);
    expect(countPendingTagWrites(db)).toBe(1);

    const r = await flushPendingTagWrites(db, c);
    expect(r).toEqual({ written: 1, failed: 0, dropped: 0, retained: 0 });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.abs).toBe(join(dir, 'Artist/Album/a.opus'));
    expect(writes[0]!.tags).toEqual({
      bpm: 128,
      key: 'A minor',
      energy: 0.7,
      loudness: -9.5,
      genre: 'Rock',
    });
    expect(countPendingTagWrites(db)).toBe(0);

    // Idempotent: a second flush has nothing to do.
    expect((await flushPendingTagWrites(db, c)).written).toBe(0);
    expect(writes).toHaveLength(1);
  });

  it('re-anchors the ledger size at the flush, like the per-task write did (#690)', async () => {
    seedSong('a');
    const c = ctx([], { fileSize: () => 4242 });
    await runTasks(c, ['bpm']);
    expect(db.query('SELECT size FROM library_songs').get()).toEqual({ size: 10 });
    await flushPendingTagWrites(db, c);
    expect(db.query('SELECT size FROM library_songs').get()).toEqual({ size: 4242 });
  });

  it('without deferTagWrites the task still writes immediately', async () => {
    seedSong('a');
    const writes: Array<{ abs: string; tags: FlushTags }> = [];
    await runTasks(ctx(writes, { deferTagWrites: false }), ['bpm']);
    expect(writes).toEqual([{ abs: join(dir, 'Artist/Album/a.opus'), tags: { bpm: 128 } }]);
    expect(countPendingTagWrites(db)).toBe(0);
  });

  it('a pending write survives a restart and is flushed by the next process', async () => {
    const file = join(dir, 'lib.db');
    db = new Database(file);
    applySchema(db);
    seedSong('a');
    await runTasks(ctx([]), ['bpm', 'key']);
    db.close();

    db = new Database(file);
    applySchema(db);
    expect(countPendingTagWrites(db)).toBe(1);
    const writes: Array<{ abs: string; tags: FlushTags }> = [];
    await flushPendingTagWrites(db, ctx(writes));
    expect(writes.map((w) => w.tags)).toEqual([{ bpm: 128, key: 'A minor' }]);
    expect(countPendingTagWrites(db)).toBe(0);
    db.close();
  });

  it('a song deleted before the flush gets no write, and its row is dropped', async () => {
    seedSong('a');
    await runTasks(ctx([]), ['bpm']);
    db.run(`DELETE FROM library_songs WHERE id = 'a'`);
    const writes: Array<{ abs: string; tags: FlushTags }> = [];
    const r = await flushPendingTagWrites(db, ctx(writes));
    expect(writes).toHaveLength(0);
    expect(r.dropped).toBe(1);
    expect(countPendingTagWrites(db)).toBe(0);
  });

  it('a curator edit between enqueue and flush wins over the derived value', async () => {
    seedSong('a');
    await runTasks(ctx([]), ['bpm', 'key']);
    // The manual edit path writes the DB (and its own file tag) directly.
    db.run(`UPDATE library_songs SET bpm = 64, key = 'C major' WHERE id = 'a'`);
    const writes: Array<{ abs: string; tags: FlushTags }> = [];
    await flushPendingTagWrites(db, ctx(writes));
    expect(writes.map((w) => w.tags)).toEqual([{ bpm: 64, key: 'C major' }]);
  });

  it('an edit landing DURING the write keeps the row, so the next flush mirrors it', async () => {
    seedSong('a');
    await runTasks(ctx([]), ['bpm']);
    const writes: Array<{ abs: string; tags: FlushTags }> = [];
    const racing = ctx(writes, {
      writeTags: async (abs, tags) => {
        writes.push({ abs, tags });
        if (writes.length === 1) db.run(`UPDATE library_songs SET bpm = 70 WHERE id = 'a'`);
        return true;
      },
    });
    expect((await flushPendingTagWrites(db, racing)).retained).toBe(1);
    expect(countPendingTagWrites(db)).toBe(1);
    await flushPendingTagWrites(db, racing);
    expect(writes.map((w) => w.tags)).toEqual([{ bpm: 128 }, { bpm: 70 }]);
    expect(countPendingTagWrites(db)).toBe(0);
  });

  it('songs are independent: flushing A leaves B pending, and A failing does not stop B', async () => {
    seedSong('a');
    seedSong('b');
    enqueueTagWrite(db, 'a', ['bpm']);
    enqueueTagWrite(db, 'b', ['bpm']);
    db.run(`UPDATE library_songs SET bpm = 100`);

    const writes: Array<{ abs: string; tags: FlushTags }> = [];
    await flushPendingTagWrites(db, ctx(writes), { songIds: ['a'] });
    expect(writes.map((w) => w.abs)).toEqual([join(dir, 'Artist/Album/a.opus')]);
    expect(db.query('SELECT song_id FROM library_pending_tag_writes').all()).toEqual([
      { song_id: 'b' },
    ]);

    enqueueTagWrite(db, 'a', ['bpm']);
    const failing = ctx([], {
      writeTags: async (abs, tags) => {
        if (abs.endsWith('a.opus')) throw new Error('boom');
        writes.push({ abs, tags });
        return true;
      },
    });
    const r = await flushPendingTagWrites(db, failing);
    expect(r.failed).toBe(1);
    expect(r.written).toBe(1);
    expect(writes.at(-1)!.abs).toBe(join(dir, 'Artist/Album/b.opus'));
    // A failed write is dropped like the per-task write it replaces (DB keeps it).
    expect(countPendingTagWrites(db)).toBe(0);
  });

  it('a re-enqueue merges fields rather than replacing them', async () => {
    seedSong('a');
    enqueueTagWrite(db, 'a', ['bpm'], 5);
    enqueueTagWrite(db, 'a', ['genre', 'key'], 5);
    const row = db
      .query<{ fields: string; enqueued_at: number }, []>(
        'SELECT fields, enqueued_at FROM library_pending_tag_writes',
      )
      .get()!;
    expect(row.fields).toBe('bpm,genre,key');
    // Strictly later, so a flush in flight cannot delete the newer enqueue.
    expect(row.enqueued_at).toBe(6);
  });

  it('the processing service flushes once per song at the end of a batch', async () => {
    seedSong('a');
    seedSong('b');
    setProcessingSettings(db, {
      tasks: { bpm: true, genre: true, key: true, energy: true },
    });
    const writes: Array<{ abs: string; tags: FlushTags }> = [];
    const svc = new LibraryProcessingService({
      db,
      lidarr: null,
      musicDir: dir,
      dataDir: dir,
      logToFile: false,
      contextFactory: () => ctx(writes),
    });
    await svc.enrichNewSongsNow();
    expect(writes).toHaveLength(2);
    expect(new Set(writes.map((w) => Object.keys(w.tags).sort().join(',')))).toEqual(
      new Set(['bpm,energy,genre,key,loudness']),
    );
    expect(countPendingTagWrites(db)).toBe(0);
  });

  it('a tick with enrichment disabled still flushes what a previous run queued', async () => {
    seedSong('a');
    enqueueTagWrite(db, 'a', ['bpm']);
    db.run(`UPDATE library_songs SET bpm = 99`);
    setProcessingSettings(db, { enabled: false });
    const writes: Array<{ abs: string; tags: FlushTags }> = [];
    const svc = new LibraryProcessingService({
      db,
      lidarr: null,
      musicDir: dir,
      dataDir: dir,
      logToFile: false,
      contextFactory: () => ctx(writes),
    });
    await svc.tick();
    expect(writes.map((w) => w.tags)).toEqual([{ bpm: 99 }]);
    expect(countPendingTagWrites(db)).toBe(0);
  });
});

describe.if(ffmpegAvailable())('a flushed write on a real Opus file (#1311)', () => {
  it('lands every field in one rewrite and keeps the cover and every other tag', async () => {
    const { attachPictureToOpus, readOggPicture } = await import('../opus-artwork.js');
    const rel = 'Artist/Album/a.opus';
    const abs = join(dir, rel);
    mkdirSync(join(dir, 'Artist/Album'), { recursive: true });
    const cover = join(dir, 'cover.jpg');
    spawnSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=96x96',
      '-frames:v',
      '1',
      cover,
    ]);
    spawnSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=1',
      '-c:a',
      'libopus',
      '-metadata',
      'title=Keep Title',
      '-metadata',
      'artist=Keep Artist',
      '-metadata',
      'album=Keep Album',
      '-metadata',
      'date=1999',
      abs,
    ]);
    expect(await attachPictureToOpus(abs, cover)).toBe(true);
    const picBefore = await readOggPicture(abs);
    expect(picBefore).not.toBeNull();
    const tagsBefore = await readAudioTags(abs);
    const statBefore = statSync(abs);

    seedSong('a', rel);
    let fileWrites = 0;
    const c = ctx([], {
      readTags: (p) => readAudioTags(p),
      writeTags: async (p, t) => {
        fileWrites++;
        return writeAudioTags(p, t);
      },
      fileExists: (p) => existsSync(p),
      fileSize: (p) => statSync(p).size,
    });
    await runTasks(c);
    // Nothing touched the file while the tasks ran — the caches stay valid.
    expect(fileWrites).toBe(0);
    expect(statSync(abs).mtimeMs).toBe(statBefore.mtimeMs);
    expect(statSync(abs).size).toBe(statBefore.size);

    await flushPendingTagWrites(db, c);
    expect(fileWrites).toBe(1);

    const after = await readAudioTags(abs);
    expect(after.bpm).toBe(128);
    expect(after.key).toBe('A minor');
    expect(after.genre).toBe('Rock');
    expect(after.energy).toBeCloseTo(0.7, 5);
    expect(after.loudness).toBeCloseTo(-9.5, 5);
    // What we did NOT intend to change: the cover bytes and every prior tag.
    expect((await readOggPicture(abs))?.data.equals(picBefore!.data)).toBe(true);
    expect(after.title).toBe(tagsBefore.title);
    expect(after.artist).toBe(tagsBefore.artist);
    expect(after.album).toBe(tagsBefore.album);
    expect(after.year).toBe(tagsBefore.year);
    expect(tagsBefore.title).toBe('Keep Title');
    // The ledger size follows the one real write.
    expect(db.query('SELECT size FROM library_songs').get()).toEqual({
      size: statSync(abs).size,
    });
  });
});

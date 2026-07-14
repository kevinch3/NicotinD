import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getTranscodedFile,
  pruneTranscodeCache,
  transcodeCacheKey,
  type FileTranscoder,
} from './transcode-cache.js';

let musicDir: string;
let cacheDir: string;
let srcPath: string;

beforeEach(() => {
  musicDir = mkdtempSync(join(tmpdir(), 'nd-tc-music-'));
  cacheDir = mkdtempSync(join(tmpdir(), 'nd-tc-cache-'));
  srcPath = join(musicDir, 'song.flac');
  writeFileSync(srcPath, 'ORIGINAL-LOSSLESS-AUDIO');
});

afterEach(() => {
  rmSync(musicDir, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
});

/** Fake transcoder: writes deterministic bytes and counts invocations. */
function makeTranscoder(): { fn: FileTranscoder; calls: () => number } {
  let count = 0;
  const fn: FileTranscoder = async (_absPath, outPath) => {
    count += 1;
    writeFileSync(outPath, `TRANSCODED-${count}`);
  };
  return { fn, calls: () => count };
}

describe('transcode cache', () => {
  it('transcodes on a miss and returns a complete cached file', async () => {
    const t = makeTranscoder();
    const out = await getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: t.fn });
    expect(existsSync(out)).toBe(true);
    expect(out.endsWith('.mp3')).toBe(true);
    expect(await Bun.file(out).text()).toBe('TRANSCODED-1');
    expect(t.calls()).toBe(1);
  });

  it('serves from cache on a hit without re-transcoding', async () => {
    const t = makeTranscoder();
    const first = await getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: t.fn });
    const second = await getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: t.fn });
    expect(second).toBe(first);
    expect(t.calls()).toBe(1); // only the miss transcoded
  });

  it('keys by format/bitrate (different settings → different entry)', async () => {
    const t = makeTranscoder();
    const mp3 = await getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: t.fn });
    const aac = await getTranscodedFile(cacheDir, srcPath, 'aac', 128, { transcoder: t.fn });
    expect(aac).not.toBe(mp3);
    expect(t.calls()).toBe(2);
  });

  it('re-transcodes when the source mtime changes (key includes mtime)', async () => {
    const t = makeTranscoder();
    await getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: t.fn });
    // Bump the source mtime (e.g. the file was re-encoded in place).
    const future = new Date(Date.now() + 60_000);
    utimesSync(srcPath, future, future);
    await getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: t.fn });
    expect(t.calls()).toBe(2);
  });

  it('dedupes concurrent requests into a single transcode', async () => {
    let count = 0;
    const slow: FileTranscoder = async (_abs, outPath) => {
      count += 1;
      await new Promise((r) => setTimeout(r, 25));
      writeFileSync(outPath, 'X');
    };
    const [a, b, c] = await Promise.all([
      getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: slow }),
      getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: slow }),
      getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: slow }),
    ]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(count).toBe(1);
  });

  it('produces a stable, deterministic cache key', () => {
    const k1 = transcodeCacheKey('/m/a.flac', 1000, 'mp3', 192);
    const k2 = transcodeCacheKey('/m/a.flac', 1000.4, 'mp3', 192); // mtime rounded
    const k3 = transcodeCacheKey('/m/a.flac', 2000, 'mp3', 192);
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('produces different cache keys for vocal-removed vs normal transcodes', () => {
    const normal = transcodeCacheKey('/m/a.flac', 1000, 'opus', 128, false);
    const vocalRemoved = transcodeCacheKey('/m/a.flac', 1000, 'opus', 128, true);
    expect(normal).not.toBe(vocalRemoved);
  });

  it('caches vocal-removed variants separately from normal transcodes', async () => {
    const t = makeTranscoder();
    const normal = await getTranscodedFile(cacheDir, srcPath, 'opus', 128, { transcoder: t.fn });
    const vocalRemoved = await getTranscodedFile(cacheDir, srcPath, 'opus', 128, {
      transcoder: t.fn,
      vocalRemoval: true,
    });
    expect(vocalRemoved).not.toBe(normal);
    expect(t.calls()).toBe(2);
  });

  it('evicts oldest files when over the disk budget', async () => {
    // Three 100-byte entries, budget 250 → oldest one evicted.
    const names = ['a', 'b', 'c'];
    let mtime = Date.now() - 3000;
    for (const n of names) {
      const p = join(cacheDir, `${n}.mp3`);
      writeFileSync(p, 'x'.repeat(100));
      const when = new Date(mtime);
      utimesSync(p, when, when);
      mtime += 1000; // a oldest, c newest
    }
    await pruneTranscodeCache(cacheDir, 250);
    const remaining = readdirSync(cacheDir).sort();
    expect(remaining).toEqual(['b.mp3', 'c.mp3']);
  });
});

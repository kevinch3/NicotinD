import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  statSync,
  utimesSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getTranscodedFile,
  pinTranscodeCacheFile,
  pruneTranscodeCache,
  schedulePinRelease,
  transcodeCacheKey,
  _pinRefcountForTests,
  _resetTranscodeCacheForTests,
  type FileTranscoder,
} from './transcode-cache.js';

let musicDir: string;
let cacheDir: string;
let srcPath: string;

beforeEach(() => {
  musicDir = mkdtempSync(join(tmpdir(), 'nd-tc-music-'));
  cacheDir = mkdtempSync(join(tmpdir(), 'nd-tc-cache-'));
  srcPath = join(musicDir, 'song.flac');
  // Use a body long enough to clear the size floor so the file-rewrite cache
  // tests below don't accidentally trip the unusable-hit guard.
  writeFileSync(srcPath, 'ORIGINAL-LOSSLESS-AUDIO'.repeat(64));
  _resetTranscodeCacheForTests();
});

afterEach(() => {
  rmSync(musicDir, { recursive: true, force: true });
  rmSync(cacheDir, { recursive: true, force: true });
});

/** Fake transcoder: writes deterministic bytes and records each invocation. */
function makeTranscoder(): { fn: FileTranscoder; calls: () => number; vocalFlags: boolean[] } {
  let count = 0;
  const vocalFlags: boolean[] = [];
  const fn: FileTranscoder = async (_absPath, outPath, _format, _kbps, vocalRemoval) => {
    count += 1;
    vocalFlags.push(vocalRemoval);
    // Write enough bytes to satisfy the cache-hit size floor.
    writeFileSync(outPath, `TRANSCODED-${count}-`.repeat(128));
  };
  return { fn, calls: () => count, vocalFlags };
}

describe('transcode cache', () => {
  it('transcodes on a miss and returns a complete cached file', async () => {
    const t = makeTranscoder();
    const out = await getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: t.fn });
    expect(existsSync(out)).toBe(true);
    expect(out.endsWith('.mp3')).toBe(true);
    expect((await Bun.file(out).text()).startsWith('TRANSCODED-1-')).toBe(true);
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

  it('the stem variant encodes an alternate input while keyed on the original (issue #603)', async () => {
    const inputs: string[] = [];
    const vocalFlags: boolean[] = [];
    const transcoder: FileTranscoder = async (absPath, outPath, _f, _k, vocalRemoval) => {
      inputs.push(absPath);
      vocalFlags.push(vocalRemoval);
      writeFileSync(outPath, 'STEM-ENCODE-'.repeat(128));
    };
    const stemFlac = join(musicDir, 'stem.flac');
    writeFileSync(stemFlac, 'INSTRUMENTAL'.repeat(512));
    const out = await getTranscodedFile(cacheDir, srcPath, 'mp3', 192, {
      transcoder,
      variant: 'stem',
      inputPath: stemFlac,
    });
    // ffmpeg read the stem; the cache name is the ORIGINAL's identity + |stem;
    // the basic center-cancel filter is NOT applied on top of an ML stem.
    expect(inputs).toEqual([stemFlac]);
    const st = statSync(srcPath);
    expect(out).toBe(
      join(cacheDir, `${transcodeCacheKey(srcPath, st.mtimeMs, st.size, 'mp3', 192, 'stem')}.mp3`),
    );
    expect(vocalFlags).toEqual([false]);
  });

  it('keys by vocal-removal flag (filtered stream is a distinct cache entry)', async () => {
    const t = makeTranscoder();
    const normal = await getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: t.fn });
    const noVocals = await getTranscodedFile(cacheDir, srcPath, 'mp3', 192, {
      transcoder: t.fn,
      variant: 'novox',
    });
    expect(noVocals).not.toBe(normal);
    expect(t.calls()).toBe(2);
    // The transcoder is told to filter for the vocal-removal request.
    expect(t.vocalFlags).toEqual([false, true]);
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

  it('re-transcodes when the source size changes (key includes size)', async () => {
    // Same mtime, different size — a file replacement that didn't bump mtime
    // (some filesystems only resolve mtime to the second) must still invalidate
    // the cached transcode, otherwise a short replacement would replay the old
    // long version (or vice versa).
    const t = makeTranscoder();
    await getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: t.fn });
    const originalStat = statSync(srcPath);
    utimesSync(srcPath, new Date(originalStat.mtimeMs), new Date(originalStat.mtimeMs));
    writeFileSync(srcPath, 'SHORTER-VERSION');
    const sameMtime = new Date(originalStat.mtimeMs);
    utimesSync(srcPath, sameMtime, sameMtime);
    await getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: t.fn });
    expect(t.calls()).toBe(2);
  });

  it('treats a zero-byte final-named file as a miss and re-transcodes', async () => {
    // A corrupt/half-written file at the final cache name used to be served
    // verbatim (the route's only check was `existsSync`). The user-facing
    // symptom: track plays 1-2 s then ends because the browser reports a tiny
    // duration. The size-floor guard now treats this as a miss.
    const t = makeTranscoder();
    const out = await getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: t.fn });
    expect(statSync(out).size).toBeGreaterThan(0);

    // Simulate a corrupt cache entry landing at the final name.
    writeFileSync(out, '');
    expect(statSync(out).size).toBe(0);

    const second = await getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: t.fn });
    expect(second).toBe(out);
    expect(statSync(out).size).toBeGreaterThan(0); // re-transcoded
    expect(t.calls()).toBe(2);
  });

  it('treats a sub-floor final-named file as a miss and re-transcodes', async () => {
    // Below the 1 KiB floor → almost certainly garbage. The user-visible
    // failure mode is the same as the zero-byte case.
    const t = makeTranscoder();
    const out = await getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: t.fn });
    writeFileSync(out, 'x'.repeat(100));
    await getTranscodedFile(cacheDir, srcPath, 'mp3', 192, { transcoder: t.fn });
    expect(t.calls()).toBe(2);
    expect(statSync(out).size).toBeGreaterThan(1024);
  });

  it('dedupes concurrent requests into a single transcode', async () => {
    let count = 0;
    const slow: FileTranscoder = async (_abs, outPath) => {
      count += 1;
      await new Promise((r) => setTimeout(r, 25));
      writeFileSync(outPath, 'X'.repeat(2048));
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
    const k1 = transcodeCacheKey('/m/a.flac', 1000, 12345, 'mp3', 192);
    const k2 = transcodeCacheKey('/m/a.flac', 1000.4, 12345, 'mp3', 192); // mtime rounded
    const k3 = transcodeCacheKey('/m/a.flac', 2000, 12345, 'mp3', 192);
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('size participates in the key (different sizes → different entries)', () => {
    const a = transcodeCacheKey('/m/a.flac', 1000, 12345, 'mp3', 192);
    const b = transcodeCacheKey('/m/a.flac', 1000, 99999, 'mp3', 192);
    expect(a).not.toBe(b);
  });

  it('vocal-removal changes the key, and the default key is unchanged (cache-preserving)', () => {
    const normal = transcodeCacheKey('/m/a.flac', 1000, 12345, 'mp3', 192);
    const noVocals = transcodeCacheKey('/m/a.flac', 1000, 12345, 'mp3', 192, 'novox');
    const stem = transcodeCacheKey('/m/a.flac', 1000, 12345, 'mp3', 192, 'stem');
    // Three distinct entries: plain, the basic filter, the ML stem (issue #603).
    expect(stem).not.toBe(normal);
    expect(stem).not.toBe(noVocals);
    expect(noVocals).not.toBe(normal);
    // Passing the flag falsy must match the 5-arg call so existing cache entries survive.
    expect(transcodeCacheKey('/m/a.flac', 1000, 12345, 'mp3', 192, 'plain')).toBe(normal);
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

  it('skips pinned files when pruning (an in-flight read cannot be evicted)', async () => {
    // Three 100-byte entries, budget 250 → the two oldest would be evicted,
    // but the middle one is pinned by a live streaming response, so only
    // `a.mp3` is removed.
    const names = ['a', 'b', 'c'];
    let mtime = Date.now() - 3000;
    const paths: Record<string, string> = {};
    for (const n of names) {
      const p = join(cacheDir, `${n}.mp3`);
      writeFileSync(p, 'x'.repeat(100));
      const when = new Date(mtime);
      utimesSync(p, when, when);
      paths[n] = p;
      mtime += 1000;
    }
    const release = pinTranscodeCacheFile(paths.b);
    try {
      await pruneTranscodeCache(cacheDir, 250);
    } finally {
      release();
    }
    const remaining = readdirSync(cacheDir).sort();
    expect(remaining).toEqual(['b.mp3', 'c.mp3']);
    // Once unpinned, the next prune catches up.
    await pruneTranscodeCache(cacheDir, 150);
    expect(readdirSync(cacheDir).sort()).toEqual(['c.mp3']);
  });

  it('pinTranscodeCacheFile is refcounted across concurrent readers', () => {
    // Two pin() calls for the same path must both release() before the file
    // is evictable — a single release only decrements the refcount.
    const release1 = pinTranscodeCacheFile('/tmp/x.mp3');
    const release2 = pinTranscodeCacheFile('/tmp/x.mp3');
    expect(_pinRefcountForTests('/tmp/x.mp3')).toBe(2);
    release1();
    expect(_pinRefcountForTests('/tmp/x.mp3')).toBe(1);
    release2();
    expect(_pinRefcountForTests('/tmp/x.mp3')).toBe(0);
  });

  it('schedulePinRelease holds the pin through the grace period, then releases', async () => {
    // The streaming route releases its pin on a grace timer (the pin only has
    // to outlive Bun opening the file — see schedulePinRelease's doc). Verify
    // the timer path actually releases and that it isn't immediate.
    const release = pinTranscodeCacheFile('/tmp/graced.mp3');
    schedulePinRelease(release, 15);
    expect(_pinRefcountForTests('/tmp/graced.mp3')).toBe(1);
    const deadline = Date.now() + 2000;
    while (_pinRefcountForTests('/tmp/graced.mp3') > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(_pinRefcountForTests('/tmp/graced.mp3')).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetWaveformCacheForTests,
  getWaveform,
  pruneWaveformCache,
  waveformCacheKey,
  type PcmDecoder,
} from './waveform-store.js';

const SR = 44_100;
let dir: string;
let cacheDir: string;
let song: string;

function sineDecoder(hz = 440, seconds = 2): PcmDecoder & { calls: number } {
  const fn = (async (_abs: string, onChunk: (s: Float32Array) => void) => {
    fn.calls++;
    const out = new Float32Array(SR * seconds);
    for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
    // Deliver in two chunks — the store must feed the reducer incrementally.
    onChunk(out.subarray(0, 30_000));
    onChunk(out.subarray(30_000));
  }) as PcmDecoder & { calls: number };
  fn.calls = 0;
  return fn;
}

beforeEach(() => {
  _resetWaveformCacheForTests();
  dir = mkdtempSync(join(tmpdir(), 'nd-wave-'));
  cacheDir = join(dir, 'waveform-cache');
  song = join(dir, 'song.opus');
  writeFileSync(song, new Uint8Array(1000));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('waveformCacheKey', () => {
  it('changes with path, mtime and size', () => {
    const a = waveformCacheKey('/m/a.opus', 1000, 10);
    expect(waveformCacheKey('/m/a.opus', 1000, 10)).toBe(a);
    expect(waveformCacheKey('/m/b.opus', 1000, 10)).not.toBe(a);
    expect(waveformCacheKey('/m/a.opus', 2000, 10)).not.toBe(a);
    expect(waveformCacheKey('/m/a.opus', 1000, 11)).not.toBe(a);
  });
});

describe('getWaveform', () => {
  it('decodes once, writes the artifact, and serves the cache afterwards', async () => {
    const decoder = sineDecoder();
    const first = await getWaveform(cacheDir, song, { decoder });
    expect(first.peaks.length).toBeGreaterThan(0);
    expect(first.bands.length).toBeGreaterThan(0);
    expect(readdirSync(cacheDir).filter((n) => n.endsWith('.json'))).toHaveLength(1);

    const second = await getWaveform(cacheDir, song, { decoder });
    expect(decoder.calls).toBe(1);
    expect(second).toEqual(first);
  });

  it('re-decodes when the file changes size (same path, same id)', async () => {
    const decoder = sineDecoder();
    await getWaveform(cacheDir, song, { decoder });
    writeFileSync(song, new Uint8Array(2000));
    await getWaveform(cacheDir, song, { decoder });
    expect(decoder.calls).toBe(2);
  });

  it('shares one decode between concurrent requests for the same file', async () => {
    const decoder = sineDecoder();
    await Promise.all([
      getWaveform(cacheDir, song, { decoder }),
      getWaveform(cacheDir, song, { decoder }),
      getWaveform(cacheDir, song, { decoder }),
    ]);
    expect(decoder.calls).toBe(1);
  });

  it('treats a corrupt cache file as a miss', async () => {
    const decoder = sineDecoder();
    await getWaveform(cacheDir, song, { decoder });
    const st = statSync(song);
    const file = join(cacheDir, `${waveformCacheKey(song, st.mtimeMs, st.size)}.json`);
    writeFileSync(file, '{not json');
    const again = await getWaveform(cacheDir, song, { decoder });
    expect(decoder.calls).toBe(2);
    expect(again.peaks.length).toBeGreaterThan(0);
  });

  it('shares one decode between concurrent requests that both find a corrupt artifact', async () => {
    const decoder = sineDecoder();
    await getWaveform(cacheDir, song, { decoder });
    const st = statSync(song);
    const file = join(cacheDir, `${waveformCacheKey(song, st.mtimeMs, st.size)}.json`);
    writeFileSync(file, '{not json');
    const [a, b] = await Promise.all([
      getWaveform(cacheDir, song, { decoder }),
      getWaveform(cacheDir, song, { decoder }),
    ]);
    expect(decoder.calls).toBe(2);
    expect(b).toBe(a);
    expect(JSON.parse(readFileSync(file, 'utf8')).peaks.length).toBeGreaterThan(0);
  });

  it('rejects for a missing source file without writing anything', async () => {
    const decoder = sineDecoder();
    await expect(getWaveform(cacheDir, join(dir, 'gone.opus'), { decoder })).rejects.toThrow();
    expect(decoder.calls).toBe(0);
  });

  it('propagates a decode failure (no artifact is written)', async () => {
    const decoder: PcmDecoder = async () => {
      throw new Error('Invalid data found when processing input');
    };
    await expect(getWaveform(cacheDir, song, { decoder })).rejects.toThrow('Invalid data');
    // Nothing was written — not even the directory is created before a decode succeeds.
    const written = existsSync(cacheDir) ? readdirSync(cacheDir) : [];
    expect(written.filter((n) => n.endsWith('.json'))).toHaveLength(0);
  });
});

describe('pruneWaveformCache', () => {
  it('evicts oldest artifacts until the directory fits the budget', async () => {
    const decoder = sineDecoder();
    const songs = ['a', 'b', 'c'].map((n) => {
      const p = join(dir, `${n}.opus`);
      writeFileSync(p, new Uint8Array(100 + n.charCodeAt(0)));
      return p;
    });
    for (const [i, p] of songs.entries()) {
      await getWaveform(cacheDir, p, { decoder, budgetBytes: Number.MAX_SAFE_INTEGER });
      const st = statSync(p);
      const file = join(cacheDir, `${waveformCacheKey(p, st.mtimeMs, st.size)}.json`);
      const t = 1_700_000_000 + i * 1000; // a.json oldest
      utimesSync(file, t, t);
    }
    const sizes = readdirSync(cacheDir).map((n) => statSync(join(cacheDir, n)).size);
    const total = sizes.reduce((a, b) => a + b, 0);
    await pruneWaveformCache(cacheDir, total - 1); // force exactly one eviction
    const left = readdirSync(cacheDir);
    expect(left).toHaveLength(2);
    const stA = statSync(songs[0]!);
    expect(left).not.toContain(`${waveformCacheKey(songs[0]!, stA.mtimeMs, stA.size)}.json`);
  });
});

describe('the /peaks request path never blocks on sync fs (#1328)', () => {
  it('waveform-store.ts uses no synchronous fs call', () => {
    const src = readFileSync(join(import.meta.dir, 'waveform-store.ts'), 'utf8');
    expect(src.match(/\b\w+Sync\(/g) ?? []).toEqual([]);
  });

  it('the /peaks handler in streaming.ts uses no synchronous fs call', () => {
    const src = readFileSync(join(import.meta.dir, '../routes/streaming.ts'), 'utf8');
    const start = src.indexOf("app.get('/peaks/:id'");
    expect(start).toBeGreaterThan(0);
    const handler = src.slice(start, src.indexOf('return app;', start));
    expect(handler.match(/\b\w+Sync\(/g) ?? []).toEqual([]);
  });
});

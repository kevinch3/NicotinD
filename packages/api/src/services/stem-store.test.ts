import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STEM_MODEL_ID,
  STEM_VERSION,
  StemOutputRejectedError,
  _resetStemStoreForTests,
  produceStem,
  pruneStemCache,
  readyStemPath,
  stemCacheKey,
  stemPathFor,
  type StemProducer,
} from './stem-store.js';

const flacProducer =
  (bytes: number, calls?: { n: number }): StemProducer =>
  async () => {
    if (calls) calls.n += 1;
    await new Promise((r) => setTimeout(r, 5));
    return new Response(new Uint8Array(bytes).fill(1), {
      headers: { 'content-type': 'audio/flac' },
    });
  };

describe('stemCacheKey', () => {
  it('changes with the source identity, the model and the store version', () => {
    const base = stemCacheKey('/m/a.mp3', 1000, 10);
    expect(stemCacheKey('/m/a.mp3', 1000, 10)).toBe(base);
    expect(stemCacheKey('/m/b.mp3', 1000, 10)).not.toBe(base);
    expect(stemCacheKey('/m/a.mp3', 2000, 10)).not.toBe(base);
    expect(stemCacheKey('/m/a.mp3', 1000, 11)).not.toBe(base);
    expect(stemCacheKey('/m/a.mp3', 1000, 10, 'other-model')).not.toBe(base);
    expect(STEM_VERSION).toBeGreaterThanOrEqual(1);
    expect(STEM_MODEL_ID).toContain('anvuew');
  });
});

describe('produceStem', () => {
  let dir = '';
  let cacheDir = '';
  let src = '';

  beforeEach(() => {
    _resetStemStoreForTests();
    dir = mkdtempSync(join(tmpdir(), 'nicotind-stem-'));
    cacheDir = join(dir, 'stem-cache');
    mkdirSync(cacheDir, { recursive: true });
    src = join(dir, 'song.mp3');
    writeFileSync(src, 'x'.repeat(2048));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('streams the body to a temp name and renames it into place once validated', async () => {
    const out = await produceStem(cacheDir, src, 'song.mp3', {
      producer: flacProducer(4096),
      timeoutMs: 1_000,
      validate: async () => true,
    });
    expect(out).toBe(stemPathFor(cacheDir, src));
    expect(statSync(out).size).toBe(4096);
    expect(readdirSync(cacheDir).some((n) => n.includes('.tmp-'))).toBe(false);
    expect(readyStemPath(cacheDir, src)).toBe(out);
  });

  it('a stem that fails the duration check is rejected deterministically and leaves nothing', async () => {
    await expect(
      produceStem(cacheDir, src, 'song.mp3', {
        producer: flacProducer(4096),
        timeoutMs: 1_000,
        validate: async () => false,
      }),
    ).rejects.toBeInstanceOf(StemOutputRejectedError);
    expect(readyStemPath(cacheDir, src)).toBeNull();
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it('a sub-floor file at the final name is not ready', () => {
    writeFileSync(stemPathFor(cacheDir, src), 'tiny', { flag: 'w' });
    expect(readyStemPath(cacheDir, src)).toBeNull();
  });

  it('concurrent requests for one track share a single production', async () => {
    const calls = { n: 0 };
    const opts = {
      producer: flacProducer(4096, calls),
      timeoutMs: 1_000,
      validate: async () => true,
    };
    const [a, b] = await Promise.all([
      produceStem(cacheDir, src, 'song.mp3', opts),
      produceStem(cacheDir, src, 'song.mp3', opts),
    ]);
    expect(a).toBe(b);
    expect(calls.n).toBe(1);
  });

  it('prunes oldest-first until the directory fits the budget', async () => {
    const names = ['a.flac', 'b.flac', 'c.flac'];
    names.forEach((n, i) => {
      const p = join(cacheDir, n);
      writeFileSync(p, new Uint8Array(1000), { flag: 'w' });
      utimesSync(p, 1_000 + i, 1_000 + i);
    });
    await pruneStemCache(cacheDir, 2_500);
    expect(readdirSync(cacheDir).sort()).toEqual(['b.flac', 'c.flac']);
  });
});

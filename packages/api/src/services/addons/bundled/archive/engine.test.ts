import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveArchive } from './engine.js';

const META = {
  metadata: { creator: 'A', title: 'B' },
  files: [{ name: 'one.mp3', format: 'VBR MP3', size: '6' }],
};

function staging(): string {
  const d = join(
    tmpdir(),
    `arch-eng-${process.pid}-${Date.now()}-${Math.round(performance.now())}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function fetchWith(body: () => ReadableStream<Uint8Array>): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url).includes('/metadata/')) return new Response(JSON.stringify(META));
    return new Response(body());
  }) as unknown as typeof fetch;
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

describe('resolveArchive default download', () => {
  it('lands the file at its final name and reports the bytes it streamed', async () => {
    const dir = staging();
    const seen: number[] = [];
    const res = await resolveArchive('https://archive.org/details/x', {
      stagingDir: dir,
      preferredFormats: ['MP3'],
      fetchFn: fetchWith(() => new Response('abcdef').body!),
      onProgress: (_i, bytes) => seen.push(bytes),
    });
    expect(readFileSync(res.files[0]!.path, 'utf8')).toBe('abcdef');
    expect(seen.at(-1)).toBe(6);
    expect(allFiles(dir)).toEqual(['one.mp3']);
  });

  it('leaves neither the file nor a .part behind when the stream breaks', async () => {
    const dir = staging();
    const broken = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('abc'));
          c.error(new Error('connection reset'));
        },
      });
    await expect(
      resolveArchive('https://archive.org/details/x', {
        stagingDir: dir,
        preferredFormats: ['MP3'],
        fetchFn: fetchWith(broken),
      }),
    ).rejects.toThrow(/connection reset/);
    expect(allFiles(dir)).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('fails a file whose server stops sending without closing', async () => {
    const dir = staging();
    const stalled = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('abc')); // then silence, never closed
        },
      });
    await expect(
      resolveArchive('https://archive.org/details/x', {
        stagingDir: dir,
        preferredFormats: ['MP3'],
        fetchFn: fetchWith(stalled),
        idleTimeoutMs: 50,
      }),
    ).rejects.toThrow(/stalled/);
    expect(allFiles(dir)).toEqual([]);
  });

  it('stops at once when the job is cancelled mid-file', async () => {
    const dir = staging();
    const controller = new AbortController();
    const pending = resolveArchive('https://archive.org/details/x', {
      stagingDir: dir,
      preferredFormats: ['MP3'],
      fetchFn: fetchWith(() => new ReadableStream<Uint8Array>({ start() {} })),
      signal: controller.signal,
      onPlan: () => setTimeout(() => controller.abort(new Error('cancelled')), 10),
    });
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(allFiles(dir)).toEqual([]);
  });
});

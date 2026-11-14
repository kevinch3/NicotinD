import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeArchiveBundledAddon } from './index.js';
import { BundledJobNotFoundError } from '../types.js';
import type { AddonJob } from '@nicotind/core';

const META = {
  metadata: { creator: 'Some Artist', title: 'Some Album' },
  files: [
    { name: 'track01.mp3', format: 'VBR MP3', size: '100' },
    { name: 'track02.mp3', format: 'VBR MP3' },
  ],
};

const fetchFn = (async (url: string | URL) => {
  if (String(url).includes('/metadata/')) return new Response(JSON.stringify(META));
  throw new Error(`unexpected fetch ${url}`);
}) as unknown as typeof fetch;

const downloadFile = async (_url: string, dest: string): Promise<void> => {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, 'audio-bytes');
};

function staging(): string {
  const d = join(tmpdir(), `arch-${process.pid}-${Date.now()}-${Math.round(performance.now())}`);
  mkdirSync(d, { recursive: true });
  return d;
}

async function waitSettled(
  getJob: (id: string) => Promise<AddonJob>,
  id: string,
): Promise<AddonJob> {
  for (let i = 0; i < 100; i++) {
    const job = await getJob(id);
    if (job.state !== 'active') return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job never settled');
}

describe('makeArchiveBundledAddon', () => {
  it('declares an archive url pattern + resolve capability', () => {
    const addon = makeArchiveBundledAddon({ stagingDir: staging(), fetchFn, downloadFile });
    expect(addon.manifest.id).toBe('bundled-archive');
    expect(addon.manifest.capabilities).toContain('resolve');
    const re = new RegExp(addon.manifest.urlPatterns![0]!);
    expect(re.test('https://archive.org/details/rec1')).toBe(true);
    expect(re.test('https://youtube.com/watch?v=x')).toBe(false);
  });

  it('resolves an archive url in the background into fileReady items with meta', async () => {
    const addon = makeArchiveBundledAddon({ stagingDir: staging(), fetchFn, downloadFile });
    const started = await addon.createJob({
      intent: 'url',
      url: 'https://archive.org/details/rec1',
    });
    expect(started.state).toBe('active'); // returns immediately, resolve runs in background
    const job = await waitSettled((id) => addon.getJob(id), started.id);
    expect(job.state).toBe('done');
    expect(job.artist).toBe('Some Artist');
    expect(job.album).toBe('Some Album');
    expect(job.items).toHaveLength(2);
    expect(job.items.every((i) => i.fileReady)).toBe(true);
    expect(existsSync(await addon.filePath(job.id, job.items[0]!.itemId))).toBe(true);
  });

  it('fails the job (not throws) when the item has no audio', async () => {
    const emptyFetch = (async () =>
      new Response(
        JSON.stringify({ metadata: { title: 'x' }, files: [] }),
      )) as unknown as typeof fetch;
    const addon = makeArchiveBundledAddon({
      stagingDir: staging(),
      fetchFn: emptyFetch,
      downloadFile,
    });
    const started = await addon.createJob({
      intent: 'url',
      url: 'https://archive.org/details/empty',
    });
    const job = await waitSettled((id) => addon.getJob(id), started.id);
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/no downloadable audio/);
  });

  it('rejects a non-url job', async () => {
    const addon = makeArchiveBundledAddon({ stagingDir: staging(), fetchFn, downloadFile });
    await expect(addon.createJob({ intent: 'album' })).rejects.toThrow(/only handles url jobs/);
  });
});

/** A download that holds each file open until the test releases it. */
function gatedDownloads() {
  const gates: Array<() => void> = [];
  const downloadFile = async (
    _url: string,
    dest: string,
    o: { onBytes?: (n: number) => void },
  ): Promise<void> => {
    o.onBytes?.(5);
    await new Promise<void>((r) => gates.push(r));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, 'audio-bytes');
  };
  const releaseNext = async (): Promise<void> => {
    for (let i = 0; i < 100 && gates.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    gates.shift()!();
  };
  return { downloadFile, releaseNext };
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition never held');
}

describe('makeArchiveBundledAddon progress (#1892)', () => {
  it('lists every file as downloading, with bytes, before any file lands', async () => {
    const g = gatedDownloads();
    const addon = makeArchiveBundledAddon({ stagingDir: staging(), fetchFn, ...g });
    const { id } = await addon.createJob({
      intent: 'url',
      url: 'https://archive.org/details/rec1',
    });
    await waitFor(async () => (await addon.getJob(id)).items[0]?.bytesTransferred === 5);
    const job = await addon.getJob(id);
    expect(job.state).toBe('active');
    expect(job.album).toBe('Some Album');
    expect(job.items.map((i) => i.state)).toEqual(['downloading', 'downloading']);
    expect(job.items.some((i) => i.fileReady)).toBe(false);
    expect(job.items[0]!.size).toBe(100); // the metadata's declared size, until the file lands
  });

  it('marks each file ready as it lands, while the rest still download', async () => {
    const g = gatedDownloads();
    const addon = makeArchiveBundledAddon({ stagingDir: staging(), fetchFn, ...g });
    const { id } = await addon.createJob({
      intent: 'url',
      url: 'https://archive.org/details/rec1',
    });
    await g.releaseNext();
    await waitFor(async () => (await addon.getJob(id)).items[0]?.fileReady === true);
    const job = await addon.getJob(id);
    expect(job.state).toBe('active');
    expect(job.items[0]!.state).toBe('completed');
    expect(job.items[1]!.state).toBe('downloading');
    expect(existsSync(await addon.filePath(id, job.items[0]!.itemId))).toBe(true);
    await g.releaseNext();
    expect((await waitSettled((x) => addon.getJob(x), id)).state).toBe('done');
  });

  it('keeps the files that landed and fails the rest when a later download fails', async () => {
    let n = 0;
    const addon = makeArchiveBundledAddon({
      stagingDir: staging(),
      fetchFn,
      downloadFile: async (u, dest) => {
        if (n++ === 1) throw new Error('connection reset');
        await downloadFile(u, dest);
      },
    });
    const { id } = await addon.createJob({
      intent: 'url',
      url: 'https://archive.org/details/rec1',
    });
    const job = await waitSettled((x) => addon.getJob(x), id);
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/connection reset/);
    expect(job.items.map((i) => [i.state, i.fileReady])).toEqual([
      ['completed', true],
      ['failed', false],
    ]);
  });

  it('deleteJob forgets the job and removes its staged files', async () => {
    const addon = makeArchiveBundledAddon({ stagingDir: staging(), fetchFn, downloadFile });
    const { id } = await addon.createJob({
      intent: 'url',
      url: 'https://archive.org/details/rec1',
    });
    const job = await waitSettled((x) => addon.getJob(x), id);
    const path = await addon.filePath(id, job.items[0]!.itemId);
    await addon.deleteJob!(id);
    expect(existsSync(path)).toBe(false);
    await expect(addon.getJob(id)).rejects.toBeInstanceOf(BundledJobNotFoundError);
  });
});

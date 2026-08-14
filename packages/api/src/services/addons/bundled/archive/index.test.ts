import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeArchiveBundledAddon } from './index.js';
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
    expect(addon.manifest.id).toBe('bundled:archive');
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

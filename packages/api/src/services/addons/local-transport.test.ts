import { describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalAddonTransport } from './local-transport.js';
import type { BundledAddon } from './bundled/types.js';
import type { AddonJob } from '@nicotind/core';

function doneJob(): AddonJob {
  return {
    id: 'j1',
    intent: 'url',
    artist: 'Some Artist',
    album: 'Some Album',
    state: 'done',
    error: null,
    items: [
      {
        itemId: 'i1',
        title: null,
        username: 'bundled:test',
        filename: 'a.flac',
        size: 2,
        state: 'completed',
        fileReady: true,
        updatedAt: 0,
      },
    ],
    createdAt: 0,
    updatedAt: 0,
  };
}

function fakeAddon(filePath: string): BundledAddon {
  return {
    manifest: {
      id: 'bundled:test',
      name: 'Test',
      description: '',
      version: '1',
      protocolVersion: '1.0.0',
      kind: 'acquisition',
      capabilities: ['resolve'],
    },
    createJob: async () => doneJob(),
    getJob: async () => doneJob(),
    listJobs: async () => [doneJob()],
    cancelJob: async () => {},
    filePath: async () => filePath,
  };
}

describe('LocalAddonTransport', () => {
  it('delegates createJob and reports an ok outcome', async () => {
    const t = new LocalAddonTransport(fakeAddon('/tmp/x'));
    let outcome: string | undefined;
    t.bindOutcome((o) => (outcome = o));
    const job = await t.createJob({ intent: 'url', url: 'u' });
    expect(job.items[0].fileReady).toBe(true);
    expect(job.artist).toBe('Some Artist');
    expect(outcome).toBe('ok');
    expect(t.baseUrl).toBe('local:bundled:test');
  });

  it('fetchFile streams the local file by path', async () => {
    const tmp = join(tmpdir(), `la-${process.pid}-${Date.now()}.txt`);
    writeFileSync(tmp, 'hi');
    const t = new LocalAddonTransport(fakeAddon(tmp));
    const res = await t.fetchFile('j1', 'i1');
    expect(await res.text()).toBe('hi');
  });

  it('rejects unsupported search/browse with a contract error', async () => {
    const t = new LocalAddonTransport(fakeAddon('/tmp/x'));
    await expect(t.search({ query: 'x' })).rejects.toThrow(/does not support search/);
    await expect(t.browse('user')).rejects.toThrow(/does not support browse/);
  });
});

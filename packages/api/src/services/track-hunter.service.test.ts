import { describe, it, expect, mock } from 'bun:test';
import type { Slskd } from '@nicotind/slskd-client';
import { TrackHunterService } from './track-hunter.service';

function makeSlskd(
  responsesByQuery: Record<string, unknown>,
  enqueue = mock(async (_username: string, _files: unknown[]) => {}),
) {
  const created: string[] = [];
  return {
    enqueue,
    slskd: {
      searches: {
        create: mock(async (q: string) => {
          created.push(q);
          return { id: `s-${created.length}` };
        }),
        get: mock(async () => ({ state: 'Completed' })),
        getResponses: mock(async (id: string) => {
          // map search id back to its query via creation order
          const q = created[Number(id.split('-')[1]) - 1];
          return (responsesByQuery[q] ?? []) as unknown[];
        }),
        delete: mock(async () => {}),
      },
      transfers: { enqueue },
    } as unknown as Slskd,
  };
}

const file = (filename: string) => ({ filename, size: 1000 });
const resp = (username: string, files: string[]) => ({
  username,
  freeUploadSlots: 1,
  files: files.map(file),
});

describe('TrackHunterService.huntAndDownload', () => {
  it('enqueues the best match per track and reports misses', async () => {
    const { slskd, enqueue } = makeSlskd({
      'Zara Larsson Lush Life': [resp('peerA', ['x\\Lush Life.flac'])],
      'Zara Larsson Never Forget You': [resp('peerA', ['x\\Never Forget You.mp3'])],
      'Zara Larsson Obscure B-side': [], // no peer has it
    });

    const result = await new TrackHunterService(slskd, { pollMs: 1, timeoutMs: 10 }).huntAndDownload(
      'Zara Larsson',
      ['Lush Life', 'Never Forget You', 'Obscure B-side'],
    );

    expect(result.requested).toBe(3);
    expect(result.enqueued).toBe(2);
    expect(result.misses).toEqual(['Obscure B-side']);
    // Both picks were from peerA → a single grouped enqueue of 2 files.
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][1]).toHaveLength(2);
  });

  it('groups files per peer and survives an enqueue failure', async () => {
    const enqueue = mock(async (username: string) => {
      if (username === 'bad') throw new Error('peer offline');
    });
    const { slskd } = makeSlskd(
      {
        'A T1': [resp('good', ['x\\T1.flac'])],
        'A T2': [resp('bad', ['x\\T2.flac'])],
      },
      enqueue,
    );

    const result = await new TrackHunterService(slskd, { pollMs: 1, timeoutMs: 10 }).huntAndDownload(
      'A',
      ['T1', 'T2'],
    );

    // good peer enqueued (1), bad peer threw → counted as not enqueued.
    expect(result.enqueued).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('falls through to a skewed query when the exact phrase is soft-banned', async () => {
    // The exact "<artist> <title>" phrase returns nothing (soft ban); the
    // title-only skew variant finds it. The pick is still enqueued.
    const { slskd, enqueue } = makeSlskd({
      'Bahiano Cuando reina el Amor': [], // soft-banned exact phrase
      'Cuando reina el Amor': [resp('peerA', ['x\\Cuando reina el Amor.flac'])],
    });

    const result = await new TrackHunterService(slskd, { pollMs: 1, timeoutMs: 10 }).huntAndDownload(
      'Bahiano',
      ['Cuando reina el Amor'],
    );

    expect(result.enqueued).toBe(1);
    expect(result.misses).toEqual([]);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('returns all misses when no peer responds', async () => {
    const { slskd, enqueue } = makeSlskd({});
    const result = await new TrackHunterService(slskd, { pollMs: 1, timeoutMs: 10 }).huntAndDownload(
      'A',
      ['T1', 'T2'],
    );
    expect(result.enqueued).toBe(0);
    expect(result.misses).toEqual(['T1', 'T2']);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

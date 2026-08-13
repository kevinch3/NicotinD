import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Slskd } from '@nicotind/slskd-client';
import { applySchema } from '../db.js';
import {
  AlbumFallbackService,
  type AlternateCandidate,
  type FallbackHost,
} from './album-fallback.service.js';

/**
 * The FallbackHost seam (#488): the fallback must consult/notify the host at
 * exactly three moments — alternate-pull repoint, done/exhausted closure, and
 * the on-disk suppression read. The api's host impl is integration-tested in
 * packages/api (album-fallback.service.test.ts + fallback-host.ts).
 */

function slskdWith(downloads: unknown[], enqueued: unknown[] = []): Slskd {
  return {
    transfers: {
      getDownloads: async () => downloads,
      enqueue: async (username: string, files: unknown[]) => {
        enqueued.push({ username, files });
      },
    },
  } as unknown as Slskd;
}

function recordJob(db: Database, alternates: AlternateCandidate[] = []): number {
  return AlbumFallbackService.recordJob(db, {
    lidarrAlbumId: 1,
    username: 'primary',
    directory: 'dir',
    artistName: 'Artist',
    albumTitle: 'Album',
    canonicalTracks: ['Song One', 'Song Two'],
    targetFiles: [{ filename: '01 Song One.mp3' }, { filename: '02 Song Two.mp3' }],
    alternates,
  });
}

function recordingHost(over: Partial<FallbackHost> = {}) {
  const calls: { repoints: unknown[]; closed: unknown[]; onDiskAsks: number } = {
    repoints: [],
    closed: [],
    onDiskAsks: 0,
  };
  const host: FallbackHost = {
    repointItems(albumJobId, username, items, audioFormat) {
      calls.repoints.push({ albumJobId, username, items, audioFormat });
    },
    jobClosed(albumJobId, state) {
      calls.closed.push({ albumJobId, state });
    },
    onDiskTitles() {
      calls.onDiskAsks++;
      return [];
    },
    ...over,
  };
  return { host, calls };
}

describe('AlbumFallbackService host seam', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('notifies jobClosed(done) when every target is satisfied', async () => {
    const jobId = recordJob(db);
    const { host, calls } = recordingHost();
    const slskd = slskdWith([
      {
        username: 'primary',
        directories: [
          {
            directory: 'dir',
            files: [
              { filename: '01 Song One.mp3', state: 'Completed, Succeeded' },
              { filename: '02 Song Two.mp3', state: 'Completed, Succeeded' },
            ],
          },
        ],
      },
    ]);
    await new AlbumFallbackService(slskd, { db, host }).sweep();
    expect(calls.closed).toEqual([{ albumJobId: jobId, state: 'done' }]);
    expect(calls.onDiskAsks).toBeGreaterThan(0);
  });

  it('repoints via the host when pulling from an alternate peer', async () => {
    const enqueued: unknown[] = [];
    const jobId = recordJob(db, [
      {
        username: 'alt',
        directory: 'altdir',
        audioFormat: 'FLAC',
        files: [{ filename: 'altdir\\01 Song One.flac', size: 1, bitRate: 900 }],
      },
    ]);
    const { host, calls } = recordingHost();
    // Primary delivered track two only; track one failed and primary is idle.
    const slskd = slskdWith(
      [
        {
          username: 'primary',
          directories: [
            {
              directory: 'dir',
              files: [{ filename: '02 Song Two.mp3', state: 'Completed, Succeeded' }],
            },
          ],
        },
      ],
      enqueued,
    );
    await new AlbumFallbackService(slskd, { db, host }).sweep();
    expect(enqueued).toHaveLength(1);
    expect(calls.repoints).toHaveLength(1);
    const repoint = calls.repoints[0] as {
      albumJobId: number;
      username: string;
      items: Array<{ title: string; filename: string }>;
      audioFormat?: string;
    };
    expect(repoint.albumJobId).toBe(jobId);
    expect(repoint.username).toBe('alt');
    expect(repoint.audioFormat).toBe('FLAC');
    expect(repoint.items[0]!.title).toBe('song one');
  });

  it('suppresses recovery for titles the host reports on disk', async () => {
    recordJob(db);
    const enqueued: unknown[] = [];
    const { host, calls } = recordingHost({
      onDiskTitles: () => ['song one', 'song two'],
    });
    const slskd = slskdWith([], enqueued);
    await new AlbumFallbackService(slskd, { db, host }).sweep();
    // Everything on disk → job closes done without any enqueue.
    expect(enqueued).toHaveLength(0);
    expect(calls.closed.map((c) => (c as { state: string }).state)).toEqual(['done']);
  });
});

describe('addon fallback host — exhausted closure', () => {
  it('flips non-completed items unavailable and resolves the job partial', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    // A protocol job with one delivered + one missing item, owned by album job 7.
    const { createAddonJob, addJobItems, getAddonJob, itemIdForTitle } =
      await import('./job-store.js');
    const { makeAddonFallbackHost } = await import('./addon-fallback-host.js');
    createAddonJob(db, {
      id: 'aj-x',
      intent: 'album',
      artist: 'A',
      album: 'B',
      albumJobId: 7,
    });
    addJobItems(db, 'aj-x', [
      {
        itemId: itemIdForTitle('One'),
        title: 'One',
        username: 'p',
        filename: '1.mp3',
        size: 1,
      },
      {
        itemId: itemIdForTitle('Two'),
        title: 'Two',
        username: 'p',
        filename: '2.mp3',
        size: 1,
      },
    ]);
    db.run(`UPDATE addon_job_items SET state = 'completed' WHERE item_id = ?`, [
      itemIdForTitle('One'),
    ]);

    makeAddonFallbackHost(db).jobClosed(7, 'exhausted');

    const job = getAddonJob(db, 'aj-x')!;
    expect(job.items.find((i) => i.title === 'Two')!.state).toBe('unavailable');
    expect(job.state).toBe('partial');
  });
});

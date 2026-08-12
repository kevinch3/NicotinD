import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  addJobItems,
  addonJobIdForAlbumJob,
  createAddonJob,
  deleteAddonJob,
  getAddonJob,
  itemIdForFile,
  itemIdForTitle,
  listAddonJobs,
  markItemsCompletedByTransfer,
  recomputeJobState,
  repointJobItem,
  setItemState,
} from './job-store.js';

describe('addon job store', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  function seedAlbumJob(id = 'job-1'): string {
    createAddonJob(db, {
      id,
      intent: 'album',
      artist: 'Artist',
      album: 'Album',
      canonicalTracks: [{ title: 'Song One' }, { title: 'Song Two' }],
      albumJobId: 7,
    });
    addJobItems(db, id, [
      {
        itemId: itemIdForTitle('Song One'),
        title: 'Song One',
        username: 'peer',
        filename: 'dir\\01 Song One.mp3',
        size: 100,
        bitRateKbps: 320,
      },
      {
        itemId: itemIdForTitle('Song Two'),
        title: 'Song Two',
        username: 'peer',
        filename: 'dir\\02 Song Two.mp3',
        size: 200,
      },
    ]);
    return id;
  }

  it('round-trips a job with items', () => {
    const id = seedAlbumJob();
    const job = getAddonJob(db, id)!;
    expect(job.state).toBe('active');
    expect(job.items).toHaveLength(2);
    expect(job.items[0]!.itemId).toBe('t:song one');
    expect(job.items[0]!.fileReady).toBe(false);
  });

  it('links album_job_id for the fallback host', () => {
    const id = seedAlbumJob();
    expect(addonJobIdForAlbumJob(db, 7)).toBe(id);
    expect(addonJobIdForAlbumJob(db, 99)).toBeNull();
  });

  it('repoints an item keeping its id stable', () => {
    const id = seedAlbumJob();
    setItemState(db, id, 't:song one', 'failed');
    repointJobItem(db, id, 't:song one', {
      username: 'alt',
      filename: 'altdir\\Song One.flac',
      bitRateKbps: 900,
      audioFormat: 'FLAC',
    });
    const item = getAddonJob(db, id)!.items.find((i) => i.itemId === 't:song one')!;
    expect(item.username).toBe('alt');
    expect(item.state).toBe('queued');
    expect(item.audioFormat).toBe('FLAC');
  });

  it('completion sync flips matching items and recomputes job state', () => {
    const id = seedAlbumJob();
    markItemsCompletedByTransfer(db, [
      { username: 'peer', filename: 'dir\\01 Song One.mp3', fileReady: true },
    ]);
    let job = getAddonJob(db, id)!;
    expect(job.items.find((i) => i.itemId === 't:song one')!.state).toBe('completed');
    expect(job.state).toBe('active'); // song two still queued

    setItemState(db, id, 't:song two', 'unavailable');
    recomputeJobState(db, id);
    job = getAddonJob(db, id)!;
    expect(job.state).toBe('partial');
  });

  it('lists jobs incrementally by updated_at', async () => {
    const id = seedAlbumJob();
    const stamp = Date.now() + 1;
    await new Promise((r) => setTimeout(r, 3));
    expect(listAddonJobs(db, stamp)).toHaveLength(0);
    setItemState(db, id, 't:song one', 'downloading', { bytesTransferred: 50 });
    expect(listAddonJobs(db, stamp)).toHaveLength(1);
  });

  it('deletes a job with its items', () => {
    const id = seedAlbumJob();
    deleteAddonJob(db, id);
    expect(getAddonJob(db, id)).toBeNull();
    expect(listAddonJobs(db)).toHaveLength(0);
  });

  it('derives file item ids from basenames', () => {
    expect(itemIdForFile('a\\b\\Track.MP3')).toBe('f:track.mp3');
  });
});

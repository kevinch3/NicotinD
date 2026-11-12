import { describe, expect, it, vi } from 'vitest';
import {
  awaitDiscographyArt,
  awaitProvisioning,
  isProvisioningAccepted,
} from './await-provisioning';
import type {
  ArtistProvisioningStatus,
  DiscographyAlbum,
  DiscographyResult,
} from '../services/api/api-types';

function status(over: Partial<ArtistProvisioningStatus> = {}): ArtistProvisioningStatus {
  return {
    phase: 'running',
    target: { artistName: 'Arjona', localArtistId: 'ar1' },
    lidarrId: null,
    startedAt: null,
    finishedAt: null,
    lastOutcome: null,
    lastError: null,
    startedBy: null,
    ...over,
  };
}

const ours = (s: ArtistProvisioningStatus) => s.target?.localArtistId === 'ar1';
const noSleep = () => Promise.resolve();

describe('awaitProvisioning', () => {
  it('polls until the job goes idle and returns that status', async () => {
    const poll = vi
      .fn()
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status({ phase: 'idle', lastOutcome: 'completed', lidarrId: 9 }));
    const done = await awaitProvisioning(poll, ours, { sleep: noSleep });
    expect(poll).toHaveBeenCalledTimes(2);
    expect(done).toMatchObject({ lastOutcome: 'completed', lidarrId: 9 });
  });

  it('stops as soon as the running job is someone else’s', async () => {
    const poll = vi
      .fn()
      .mockResolvedValue(status({ target: { artistName: 'Other', artistMbid: 'm' } }));
    const done = await awaitProvisioning(poll, ours, { sleep: noSleep });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(done?.target?.artistName).toBe('Other');
  });

  it('returns null once the asking view is gone', async () => {
    const poll = vi.fn().mockResolvedValue(status());
    let alive = true;
    const sleep = vi.fn(async () => {
      if (poll.mock.calls.length === 2) alive = false;
    });
    expect(await awaitProvisioning(poll, ours, { sleep, alive: () => alive })).toBeNull();
    expect(poll).toHaveBeenCalledTimes(2);
  });
});

describe('isProvisioningAccepted', () => {
  it('recognises the 202 body and nothing else', () => {
    expect(isProvisioningAccepted({ provisioning: true, code: 'ARTIST_PROVISIONING' })).toBe(true);
    expect(isProvisioningAccepted({ albums: [] })).toBe(false);
    expect(isProvisioningAccepted(null)).toBe(false);
  });
});

describe('awaitDiscographyArt', () => {
  const album = (lidarrId: number, coverArtUrl?: string): DiscographyAlbum => ({
    lidarrId,
    foreignAlbumId: `f${lidarrId}`,
    title: `A${lidarrId}`,
    albumType: 'Album',
    secondaryTypes: [],
    totalTracks: 1,
    localTrackCount: 0,
    status: 'missing',
    coverArtUrl,
    tracks: [],
  });
  const disco = (...albums: DiscographyAlbum[]): DiscographyResult => ({
    artistId: 'ar1',
    lidarrId: 1,
    mbid: 'm',
    albums,
  });

  // Lidarr's refresh after an add lists the albums before their images (#1854).
  it('re-reads until the covers Lidarr was still fetching arrive', async () => {
    const reads = [disco(album(1), album(2)), disco(album(1, 'c1'), album(2, 'c2'))];
    const read = vi.fn(async () => reads.shift()!);
    const seen: DiscographyResult[] = [];
    await awaitDiscographyArt(disco(album(1), album(2)), read, (d) => seen.push(d), {
      sleep: noSleep,
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)!.albums.map((a) => a.coverArtUrl)).toEqual(['c1', 'c2']);
  });

  it('does not re-read when every album already has art', async () => {
    const read = vi.fn();
    await awaitDiscographyArt(disco(album(1, 'c1')), read, () => {}, { sleep: noSleep });
    expect(read).not.toHaveBeenCalled();
  });

  it('gives up after its attempts for an album that never gets art', async () => {
    const read = vi.fn(async () => disco(album(1)));
    await awaitDiscographyArt(disco(album(1)), read, () => {}, { sleep: noSleep, attempts: 3 });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('stops once the view that asked has gone', async () => {
    const read = vi.fn(async () => disco(album(1)));
    const apply = vi.fn();
    await awaitDiscographyArt(disco(album(1)), read, apply, {
      sleep: noSleep,
      alive: () => false,
    });
    expect(read).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});

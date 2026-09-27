import { describe, expect, it, vi } from 'vitest';
import { awaitProvisioning, isProvisioningAccepted } from './await-provisioning';
import type { ArtistProvisioningStatus } from '../services/api/api-types';

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

/**
 * The explicit add-artist job (issue #644): lifecycle, busy guard, cancel before
 * the irreversible add, and the discography link it leaves behind.
 */
import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Lidarr, LidarrArtist } from '../lidarr/index.js';
import { applySchema } from '../db';
import { ArtistProvisioningService, provisioningResponse } from './artist-provisioning.service.js';

function artist(over: Partial<LidarrArtist> = {}): LidarrArtist {
  return {
    id: 0,
    foreignArtistId: 'mbid-x',
    artistName: 'Arjona',
    sortName: 'Arjona',
    status: 'continuing',
    images: [],
    monitored: true,
    ...over,
  };
}

/** A Lidarr whose `add` the test releases by hand. */
function makeLidarr(opts: { monitored?: LidarrArtist[]; lookup?: LidarrArtist[] } = {}) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const add = mock(async (a: LidarrArtist) => {
    await gate;
    return { ...a, id: 77 };
  });
  const lookup = mock(async () => opts.lookup ?? [artist()]);
  const lidarr = {
    artist: {
      list: mock(async () => opts.monitored ?? []),
      lookup,
      add,
      getQualityProfiles: mock(async () => [{ id: 1, name: 'Any' }]),
      getMetadataProfiles: mock(async () => [{ id: 1, name: 'Standard' }]),
      getRootFolders: mock(async () => [{ id: 1, path: '/music', freeSpace: 0 }]),
    },
  } as unknown as Lidarr;
  return { lidarr, add, lookup, release };
}

function setup(opts: Parameters<typeof makeLidarr>[0] = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const l = makeLidarr(opts);
  const svc = new ArtistProvisioningService({ lidarr: l.lidarr, db });
  return { db, svc, ...l };
}

/** Resolves once the job reaches `idle` again. */
function finished(svc: ArtistProvisioningService): Promise<void> {
  return new Promise((resolve) => {
    const on = (s: { phase: string }) => {
      if (s.phase === 'idle') {
        svc.off('status', on);
        resolve();
      }
    };
    svc.on('status', on);
  });
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('ArtistProvisioningService', () => {
  it('starts idle with no history', () => {
    const s = setup().svc.getStatus();
    expect(s.phase).toBe('idle');
    expect(s.target).toBeNull();
    expect(s.lastOutcome).toBeNull();
  });

  it('runs the add in the background and records the discography link', async () => {
    const { svc, db, add, release } = setup();
    const done = finished(svc);
    expect(svc.start({ artistName: 'Arjona', localArtistId: 'ar1' }, 'kevin')).toBe('started');
    expect(svc.getStatus()).toMatchObject({ phase: 'running', startedBy: 'kevin' });
    expect(svc.isRunningFor({ artistName: 'Arjona', localArtistId: 'ar1' })).toBe(true);

    release();
    await done;
    expect(add).toHaveBeenCalledTimes(1);
    expect(svc.getStatus()).toMatchObject({
      phase: 'idle',
      lastOutcome: 'completed',
      lidarrId: 77,
    });
    const link = db
      .query<{ lidarr_id: number }, [string]>(
        'SELECT lidarr_id FROM artist_discography_links WHERE artist_id = ?',
      )
      .get('ar1');
    expect(link?.lidarr_id).toBe(77);
  });

  it('answers busy for a different artist and started for the same one', async () => {
    const { svc, release } = setup();
    const done = finished(svc);
    svc.start({ artistName: 'Arjona', localArtistId: 'ar1' });
    expect(svc.start({ artistName: 'Arjona', localArtistId: 'ar1' })).toBe('started');
    expect(svc.start({ artistName: 'Other', artistMbid: 'm2' })).toBe('busy');
    release();
    await done;
    expect(svc.start({ artistName: 'Other', artistMbid: 'm2' })).toBe('started');
  });

  it('does not add an artist Lidarr already monitors', async () => {
    const { svc, add } = setup({ monitored: [artist({ id: 5, artistName: 'Arjona' })] });
    const done = finished(svc);
    svc.start({ artistName: 'Arjona' });
    await done;
    expect(add).not.toHaveBeenCalled();
    expect(svc.getStatus()).toMatchObject({ lastOutcome: 'completed', lidarrId: 5 });
  });

  it('cancelled before the add never sends it', async () => {
    const { svc, add, lookup } = setup();
    let releaseLookup!: () => void;
    lookup.mockImplementation(async () => {
      await new Promise<void>((r) => (releaseLookup = r));
      return [artist()];
    });
    const done = finished(svc);
    svc.start({ artistName: 'Arjona' });
    await settle();
    expect(svc.cancel()).toBe(true);
    expect(svc.getStatus().phase).toBe('cancelling');
    releaseLookup();
    await done;
    expect(add).not.toHaveBeenCalled();
    expect(svc.getStatus().lastOutcome).toBe('cancelled');
  });

  it('cancel is false when nothing runs', () => {
    expect(setup().svc.cancel()).toBe(false);
  });

  it('fails an uncorroborated hit for a library artist (#212) instead of adding it', async () => {
    const { svc, add } = setup({ lookup: [artist({ artistName: '2' })] });
    const done = finished(svc);
    svc.start({ artistName: '2 MinutosTruenoDie Toten Hosen', localArtistId: 'ar1' });
    await done;
    expect(add).not.toHaveBeenCalled();
    expect(svc.getStatus()).toMatchObject({ lastOutcome: 'failed' });
    expect(svc.getStatus().lastError).toMatch(/No confident Lidarr match/);
  });

  it('picks the lookup hit by MusicBrainz id when the caller chose one', async () => {
    const { svc, add, release } = setup({
      lookup: [artist({ foreignArtistId: 'other' }), artist({ foreignArtistId: 'chosen' })],
    });
    const done = finished(svc);
    svc.start({ artistName: 'Arjona', artistMbid: 'chosen' });
    release();
    await done;
    expect((add.mock.calls[0] as unknown[])[0]).toMatchObject({ foreignArtistId: 'chosen' });
  });

  it('provisioningResponse maps start to 202 and busy to 409', async () => {
    const { svc, release } = setup();
    const done = finished(svc);
    const first = provisioningResponse(svc, { artistName: 'Arjona' }, 'kevin');
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ provisioning: true, code: 'ARTIST_PROVISIONING' });
    const second = provisioningResponse(svc, { artistName: 'Someone Else' });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: 'PROVISIONING_BUSY' });
    release();
    await done;
  });
});

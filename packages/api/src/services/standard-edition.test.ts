import { describe, expect, it, mock } from 'bun:test';
import type { LidarrAlbumRelease, LidarrTrack } from '../lidarr/types.js';
import {
  albumEditions,
  fetchStandardTracklist,
  folderEditionTitles,
  pickStandardRelease,
  standardTrackCount,
  standardTracklist,
} from './standard-edition.js';

let nextId = 1;
function rel(trackCount: number, over: Partial<LidarrAlbumRelease> = {}): LidarrAlbumRelease {
  return {
    id: nextId++,
    foreignReleaseId: `r${nextId}`,
    title: 'Album',
    status: 'Official',
    duration: 0,
    trackCount,
    media: [],
    country: [],
    label: [],
    disambiguation: '',
    format: 'CD',
    monitored: false,
    ...over,
  };
}

/** `n` releases of one track count — prod histograms are mostly repeats. */
function many(n: number, trackCount: number, over: Partial<LidarrAlbumRelease> = {}) {
  return Array.from({ length: n }, () => rel(trackCount, over));
}

function track(title: string): LidarrTrack {
  return {
    id: nextId++,
    foreignTrackId: '',
    foreignRecordingId: '',
    trackFileId: 0,
    albumId: 1,
    artistId: 1,
    trackNumber: '1',
    absoluteTrackNumber: 1,
    title,
    duration: 0,
    hasFile: false,
  };
}

describe('pickStandardRelease', () => {
  // Prod 2026-11-15, Lidarr album 1401: R.E.M. *Monster*, the 64-track box set monitored.
  it('takes the most common track count, not the monitored box set', () => {
    const releases = [
      ...many(23, 12),
      ...many(2, 24),
      ...many(2, 36),
      rel(64),
      rel(64, { monitored: true }),
    ];
    expect(pickStandardRelease(releases)?.trackCount).toBe(12);
  });

  // Album 13372: *Seventeen Seconds* has one odd 9-track pressing; the album is 10 tracks.
  it('does not take the smallest release', () => {
    const releases = [rel(9), ...many(22, 10), ...many(6, 25, { monitored: false })];
    expect(pickStandardRelease(releases)?.trackCount).toBe(10);
  });

  it('prefers the monitored release among those with the chosen count', () => {
    const monitored = rel(12, { monitored: true });
    expect(pickStandardRelease([rel(12), monitored, rel(12), rel(30)])).toBe(monitored);
  });

  it('breaks a tie toward fewer tracks', () => {
    expect(pickStandardRelease([...many(2, 14), ...many(2, 12)])?.trackCount).toBe(12);
  });

  it('counts official releases only when there are any', () => {
    const releases = [...many(5, 20, { status: 'Bootleg' }), ...many(2, 11)];
    expect(pickStandardRelease(releases)?.trackCount).toBe(11);
  });

  it('reads the status whatever its case, as lookup payloads spell it', () => {
    const releases = [
      ...many(5, 20, { status: 'bootleg' }),
      ...many(2, 11, { status: 'official' }),
    ];
    expect(pickStandardRelease(releases)?.trackCount).toBe(11);
  });

  it('falls back to every release when none is official', () => {
    expect(pickStandardRelease(many(2, 8, { status: 'Promotion' }))?.trackCount).toBe(8);
  });

  it('ignores releases with no tracks, and has no answer for an empty list', () => {
    expect(pickStandardRelease([rel(0), rel(0), rel(9)])?.trackCount).toBe(9);
    expect(pickStandardRelease([])).toBeNull();
    expect(pickStandardRelease(undefined)).toBeNull();
  });
});

describe('standardTracklist', () => {
  function lidarr(byAlbum: LidarrTrack[], byRelease: LidarrTrack[]) {
    return {
      track: {
        listByAlbum: mock(async () => byAlbum),
        listByRelease: mock(async () => byRelease),
      },
    };
  }
  const deluxe = ['A', 'B', 'C', 'A (demo)'].map(track);
  const standard = ['A', 'B', 'C'].map(track);

  it("reads the standard release's own tracks when Lidarr monitors another", async () => {
    const pick = rel(3);
    const l = lidarr(deluxe, standard);
    const tracks = await standardTracklist(l, 1401, [pick, rel(3), rel(4, { monitored: true })]);
    expect(tracks.map((t) => t.title)).toEqual(['A', 'B', 'C']);
    expect(l.track.listByRelease).toHaveBeenCalledWith(pick.id);
    expect(l.track.listByAlbum).not.toHaveBeenCalled();
  });

  it('keeps the one call it always made when the monitored release is the standard one', async () => {
    const l = lidarr(standard, []);
    const tracks = await standardTracklist(l, 7, [rel(3, { monitored: true }), rel(5)]);
    expect(tracks).toBe(standard);
    expect(l.track.listByRelease).not.toHaveBeenCalled();
  });

  it("falls back to the album's listing when the release comes back empty", async () => {
    const l = lidarr(deluxe, []);
    const tracks = await standardTracklist(l, 1401, [...many(2, 3), rel(4, { monitored: true })]);
    expect(tracks).toBe(deluxe);
  });

  it('falls back to the album listing when no releases are known', async () => {
    const l = lidarr(deluxe, standard);
    expect(await standardTracklist(l, 1, undefined)).toBe(deluxe);
    expect(l.track.listByRelease).not.toHaveBeenCalled();
  });
});

describe('albumEditions', () => {
  const deluxe = ['A', 'B', 'A (demo)'].map(track);
  const standard = ['A', 'B'].map(track);

  it('reads both when Lidarr monitors the box set', async () => {
    const listByRelease = mock(async () => standard);
    const lidarr = { track: { listByAlbum: async () => deluxe, listByRelease } };
    const editions = await albumEditions(lidarr, 1, [...many(2, 2), rel(3, { monitored: true })]);
    expect(editions).toEqual({ standard, full: deluxe });
  });

  it('makes the one call when the monitored release is the standard one', async () => {
    const listByRelease = mock(async () => standard);
    const lidarr = { track: { listByAlbum: async () => standard, listByRelease } };
    const editions = await albumEditions(lidarr, 1, [rel(2, { monitored: true }), rel(3)]);
    expect(editions.standard).toBe(editions.full);
    expect(listByRelease).not.toHaveBeenCalled();
  });
});

describe('fetchStandardTracklist', () => {
  const deluxe = ['A', 'B', 'A (demo)'].map(track);
  const standard = ['A', 'B'].map(track);
  const listings = {
    listByAlbum: mock(async () => deluxe),
    listByRelease: mock(async () => standard),
  };

  it("reads the album's releases, then the standard edition", async () => {
    const lidarr = {
      album: { get: async () => ({ releases: [...many(2, 2), rel(3, { monitored: true })] }) },
      track: listings,
    };
    expect(await fetchStandardTracklist(lidarr, 1)).toBe(standard);
  });

  it('keeps the album listing when the album lookup fails', async () => {
    const lidarr = {
      album: {
        get: async (): Promise<{ releases?: LidarrAlbumRelease[] }> => {
          throw new Error('Lidarr 503');
        },
      },
      track: listings,
    };
    expect(await fetchStandardTracklist(lidarr, 1)).toBe(deluxe);
  });
});

describe('folderEditionTitles', () => {
  const standard = ['Crush With Eyeliner', 'King of Comedy', 'Strange Currencies'];
  const full = [...standard, 'Crush With Eyeliner (demo)', 'Revolution', 'Fall on Me (live)'];
  const files = (...names: string[]) => names.map((n) => ({ filename: `Monster\\${n}` }));

  it('is the standard edition for a standard rip', () => {
    const picked = files(
      '01 Crush With Eyeliner.flac',
      '02 King of Comedy.flac',
      '03 Strange Currencies.flac',
    );
    expect(folderEditionTitles(standard, full, picked)).toEqual(standard);
  });

  it('adds the extra tracks a deluxe rip actually carries, and only those', () => {
    const picked = files(
      '01 Crush With Eyeliner.flac',
      '02 King of Comedy.flac',
      '03 Strange Currencies.flac',
      '04 Crush With Eyeliner (demo).flac',
      '05 Revolution.flac',
    );
    expect(folderEditionTitles(standard, full, picked)).toEqual([
      ...standard,
      'Crush With Eyeliner (demo)',
      'Revolution',
    ]);
  });

  it('keeps the whole standard edition for a partial rip, so the card can say what is missing', () => {
    expect(folderEditionTitles(standard, full, files('02 King of Comedy.flac'))).toEqual(standard);
  });

  it('is the standard edition when it is already the whole tracklist', () => {
    expect(folderEditionTitles(standard, standard, files('01 Crush With Eyeliner.flac'))).toEqual(
      standard,
    );
  });
});

describe('standardTrackCount', () => {
  it("counts the standard edition from the payload's releases", () => {
    const album = {
      releases: [...many(23, 12), rel(64, { monitored: true })],
      statistics: { trackCount: 0, totalTrackCount: 64, sizeOnDisk: 0, percentOfTracks: 0 },
    };
    expect(standardTrackCount(album)).toBe(12);
  });

  it("falls back to Lidarr's statistics, then to zero", () => {
    const statistics = { trackCount: 0, totalTrackCount: 5, sizeOnDisk: 0, percentOfTracks: 0 };
    expect(standardTrackCount({ statistics })).toBe(5);
    expect(standardTrackCount({})).toBe(0);
  });
});

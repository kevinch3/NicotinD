import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Lidarr, LidarrAlbum, LidarrArtist, LidarrTrack } from '@nicotind/lidarr-client';
import { applySchema } from '../db';
import { DiscographyService } from './discography.service';

function insertArtist(db: Database, id: string, name: string): void {
  db.run(
    `INSERT INTO library_artists (id, name, album_count, hidden, manual_override, synced_at)
     VALUES (?, ?, 0, 0, 0, ?)`,
    [id, name, Date.now()],
  );
}

function insertAlbum(db: Database, id: string, name: string, artistId: string): void {
  db.run(
    `INSERT INTO library_albums
       (id, name, artist, artist_id, classification, hidden, manual_override, synced_at)
     VALUES (?, ?, 'A', ?, 'album', 0, 0, ?)`,
    [id, name, artistId, Date.now()],
  );
}

function insertSong(
  db: Database,
  id: string,
  albumId: string,
  title: string,
  artistId: string,
): void {
  db.run(
    `INSERT INTO library_songs
       (id, album_id, title, artist, artist_id, path, hidden, synced_at)
     VALUES (?, ?, ?, 'A', ?, ?, 0, ?)`,
    [id, albumId, title, artistId, `/music/${id}.mp3`, Date.now()],
  );
}

function makeLidarrAlbum(over: Partial<LidarrAlbum> & { id: number; title: string }): LidarrAlbum {
  return {
    foreignAlbumId: `mb-${over.id}`,
    albumType: 'Album',
    monitored: true,
    statistics: { trackCount: 1, totalTrackCount: 1, sizeOnDisk: 0, percentOfTracks: 100 },
    ...over,
  };
}

function makeTrack(id: number, albumId: number, title: string): LidarrTrack {
  return {
    id,
    foreignTrackId: `ft-${id}`,
    foreignRecordingId: `fr-${id}`,
    trackFileId: 0,
    albumId,
    artistId: 1,
    trackNumber: String(id),
    absoluteTrackNumber: id,
    title,
    duration: 1000,
    hasFile: false,
  };
}

/** Build a Lidarr stub with spy-able methods. */
function makeLidarrStub(opts: {
  albums: LidarrAlbum[];
  tracksByAlbum: Record<number, LidarrTrack[]>;
  monitoredArtist?: LidarrArtist;
  lookupArtist?: LidarrArtist;
}) {
  const monitored = opts.monitoredArtist ? [opts.monitoredArtist] : [];
  const lookup = mock(async () => (opts.lookupArtist ? [opts.lookupArtist] : []));
  const add = mock(async () => opts.lookupArtist!);
  const list = mock(async () => monitored);

  const lidarr = {
    artist: {
      list,
      lookup,
      add,
      getQualityProfiles: mock(async () => [{ id: 1, name: 'Any' }]),
      getMetadataProfiles: mock(async () => [{ id: 1, name: 'Standard' }]),
      getRootFolders: mock(async () => [{ id: 1, path: '/music', freeSpace: 0 }]),
    },
    album: {
      listByArtist: mock(async () => opts.albums),
    },
    track: {
      listByAlbum: mock(async (albumId: number) => opts.tracksByAlbum[albumId] ?? []),
    },
  } as unknown as Lidarr;

  return { lidarr, spies: { lookup, add, list } };
}

describe('DiscographyService', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('diffs present / partial / missing against the local library', async () => {
    insertArtist(db, 'ar1', 'Arjona');
    // Local: "Galería Caribe" fully present (1/1), "Santo Pecado" partial (1/2)
    insertAlbum(db, 'al1', 'Galería Caribe', 'ar1');
    insertSong(db, 's1', 'al1', 'Te Quiero', 'ar1');
    insertAlbum(db, 'al2', 'Santo Pecado', 'ar1');
    insertSong(db, 's2', 'al2', 'El Problema', 'ar1');

    const albums = [
      makeLidarrAlbum({ id: 1, title: 'Galería Caribe' }),
      makeLidarrAlbum({
        id: 2,
        title: 'Santo Pecado',
        statistics: { trackCount: 2, totalTrackCount: 2, sizeOnDisk: 0, percentOfTracks: 100 },
      }),
      makeLidarrAlbum({ id: 3, title: 'Adentro' }), // missing entirely
    ];
    const tracksByAlbum: Record<number, LidarrTrack[]> = {
      1: [makeTrack(11, 1, 'Te Quiero')],
      2: [makeTrack(21, 2, 'El Problema'), makeTrack(22, 2, 'Minutos')],
      3: [makeTrack(31, 3, 'Pingüinos en la Cama')],
    };

    const { lidarr } = makeLidarrStub({
      albums,
      tracksByAlbum,
      monitoredArtist: {
        id: 99,
        foreignArtistId: 'mbid-arjona',
        artistName: 'Arjona',
        sortName: 'Arjona',
        status: 'continuing',
        images: [],
        monitored: true,
      },
    });

    const svc = new DiscographyService(lidarr, db);
    const result = await svc.getArtistDiscography('ar1');

    const byTitle = Object.fromEntries(result.albums.map((a) => [a.title, a]));
    expect(byTitle['Galería Caribe'].status).toBe('present');
    expect(byTitle['Santo Pecado'].status).toBe('partial');
    expect(byTitle['Santo Pecado'].localTrackCount).toBe(1);
    expect(byTitle['Adentro'].status).toBe('missing');
  });

  it('normalizes track-number prefixes and remaster suffixes when matching', async () => {
    insertArtist(db, 'ar1', 'Artist');
    insertAlbum(db, 'al1', 'Greatest Hits (Remastered)', 'ar1');
    insertSong(db, 's1', 'al1', '01 - Hit Song', 'ar1');

    const albums = [makeLidarrAlbum({ id: 1, title: 'Greatest Hits' })];
    const tracksByAlbum = { 1: [makeTrack(11, 1, 'Hit Song')] };

    const { lidarr } = makeLidarrStub({
      albums,
      tracksByAlbum,
      monitoredArtist: {
        id: 1,
        foreignArtistId: 'm',
        artistName: 'Artist',
        sortName: 'Artist',
        status: 'ended',
        images: [],
        monitored: true,
      },
    });

    const svc = new DiscographyService(lidarr, db);
    const result = await svc.getArtistDiscography('ar1');
    expect(result.albums[0].status).toBe('present');
  });

  it('caches the Lidarr link and skips lookup on the second call', async () => {
    insertArtist(db, 'ar1', 'Artist');
    const { lidarr, spies } = makeLidarrStub({
      albums: [],
      tracksByAlbum: {},
      monitoredArtist: {
        id: 7,
        foreignArtistId: 'm',
        artistName: 'Artist',
        sortName: 'Artist',
        status: 'ended',
        images: [],
        monitored: true,
      },
    });

    const svc = new DiscographyService(lidarr, db);
    await svc.getArtistDiscography('ar1');
    await svc.getArtistDiscography('ar1');

    // artist.list() is only used to resolve the link; second call hits the cache
    expect(spies.list).toHaveBeenCalledTimes(1);
    const row = db
      .query('SELECT lidarr_id FROM artist_discography_links WHERE artist_id = ?')
      .get('ar1') as { lidarr_id: number } | null;
    expect(row?.lidarr_id).toBe(7);
  });

  it('falls back to album-name presence when track fetch returns empty', async () => {
    insertArtist(db, 'ar1', 'Artist');
    insertAlbum(db, 'al1', 'Mono', 'ar1');
    insertSong(db, 's1', 'al1', 'Track One', 'ar1');

    const albums = [makeLidarrAlbum({ id: 1, title: 'Mono' })]; // totalTrackCount 1
    const tracksByAlbum = { 1: [] }; // track fetch "failed"

    const { lidarr } = makeLidarrStub({
      albums,
      tracksByAlbum,
      monitoredArtist: {
        id: 1,
        foreignArtistId: 'm',
        artistName: 'Artist',
        sortName: 'Artist',
        status: 'ended',
        images: [],
        monitored: true,
      },
    });

    const svc = new DiscographyService(lidarr, db);
    const result = await svc.getArtistDiscography('ar1');
    expect(result.albums[0].status).toBe('present');
  });
});

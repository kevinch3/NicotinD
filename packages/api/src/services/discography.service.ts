import type { Database } from 'bun:sqlite';
import type { Lidarr, LidarrAlbum, LidarrTrack } from '@nicotind/lidarr-client';
import { createLogger } from '@nicotind/core';

const log = createLogger('discography');

// Cache artist lookups for 7 days before re-querying Lidarr
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type AlbumStatus = 'present' | 'partial' | 'missing';

export interface DiscographyTrack {
  lidarrId: number;
  title: string;
  trackNumber: string;
  duration: number;
  hasFile: boolean;
}

export interface DiscographyAlbum {
  lidarrId: number;
  foreignAlbumId: string;
  title: string;
  releaseDate?: string;
  albumType: string;
  secondaryTypes: string[];
  totalTracks: number;
  localTrackCount: number;
  status: AlbumStatus;
  localAlbumId?: string;
  coverArtUrl?: string;
  tracks: DiscographyTrack[];
}

export interface ArtistDiscography {
  artistId: string;
  lidarrId: number;
  mbid: string;
  albums: DiscographyAlbum[];
}

export class DiscographyService {
  constructor(
    private lidarr: Lidarr,
    private db: Database,
    private musicDir?: string,
  ) {}

  async getArtistDiscography(artistId: string): Promise<ArtistDiscography> {
    const artistRow = this.db
      .query<{ name: string }, [string]>('SELECT name FROM library_artists WHERE id = ?')
      .get(artistId);

    if (!artistRow) throw new Error(`Artist ${artistId} not found in local library`);

    const lidarrId = await this.resolveOrAddArtist(artistId, artistRow.name);

    const [lidarrAlbums, localAlbums, localSongs] = await Promise.all([
      this.lidarr.album.listByArtist(lidarrId),
      this.fetchLocalAlbums(artistId),
      this.fetchLocalSongs(artistId),
    ]);

    // Fetch tracks for all albums in parallel (concurrency 5)
    const trackMap = await this.fetchAllTracks(lidarrAlbums);

    const albums = lidarrAlbums.map((album) =>
      this.buildDiscographyAlbum(album, trackMap.get(album.id) ?? [], localAlbums, localSongs),
    );

    // Sort: present first, then partial, then missing; within each group by date desc
    albums.sort((a, b) => {
      const order: Record<AlbumStatus, number> = { present: 0, partial: 1, missing: 2 };
      const diff = order[a.status] - order[b.status];
      if (diff !== 0) return diff;
      return (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '');
    });

    const link = this.db
      .query<{ mbid: string }, [string]>(
        'SELECT mbid FROM artist_discography_links WHERE artist_id = ?',
      )
      .get(artistId);

    return {
      artistId,
      lidarrId,
      mbid: link?.mbid ?? '',
      albums,
    };
  }

  private async resolveOrAddArtist(artistId: string, artistName: string): Promise<number> {
    const cached = this.db
      .query<{ lidarr_id: number; checked_at: number }, [string]>(
        'SELECT lidarr_id, checked_at FROM artist_discography_links WHERE artist_id = ?',
      )
      .get(artistId);

    if (cached && Date.now() - cached.checked_at < CACHE_TTL_MS && cached.lidarr_id) {
      return cached.lidarr_id;
    }

    log.info({ artistId, artistName }, 'Looking up artist in Lidarr');

    // Check if already monitored in Lidarr by name
    const monitored = await this.lidarr.artist.list();
    const existing = monitored.find(
      (a) => normalizeTitle(a.artistName) === normalizeTitle(artistName),
    );

    if (existing) {
      this.upsertLink(artistId, existing.id, existing.foreignArtistId);
      return existing.id;
    }

    // Lookup via MusicBrainz
    const candidates = await this.lidarr.artist.lookup(artistName);
    const best = candidates[0];
    if (!best) throw new Error(`Lidarr found no artist matching "${artistName}"`);

    // Get quality profile and root folder for add
    const [profiles, initialRootFolders] = await Promise.all([
      this.lidarr.artist.getQualityProfiles(),
      this.lidarr.artist.getRootFolders(),
    ]);

    if (!profiles.length) throw new Error('Lidarr has no quality profiles configured');

    let rootFolders = initialRootFolders;
    if (!rootFolders.length) {
      if (!this.musicDir) throw new Error('Lidarr has no root folders configured');
      log.info({ path: this.musicDir }, 'No Lidarr root folder — provisioning music dir');
      const added = await this.lidarr.artist.addRootFolder(this.musicDir);
      rootFolders = [added];
    }

    const added = await this.lidarr.artist.add(
      best,
      profiles[0].id,
      rootFolders[0].path,
    );

    this.upsertLink(artistId, added.id, added.foreignArtistId);
    log.info({ artistName, lidarrId: added.id }, 'Artist added to Lidarr');
    return added.id;
  }

  private upsertLink(artistId: string, lidarrId: number, mbid: string): void {
    this.db
      .query(
        `INSERT INTO artist_discography_links (artist_id, lidarr_id, mbid, checked_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(artist_id) DO UPDATE SET
           lidarr_id = excluded.lidarr_id,
           mbid = excluded.mbid,
           checked_at = excluded.checked_at`,
      )
      .run(artistId, lidarrId, mbid, Date.now());
  }

  private async fetchAllTracks(
    albums: LidarrAlbum[],
  ): Promise<Map<number, LidarrTrack[]>> {
    const result = new Map<number, LidarrTrack[]>();
    const concurrency = 5;

    for (let i = 0; i < albums.length; i += concurrency) {
      const batch = albums.slice(i, i + concurrency);
      const fetched = await Promise.all(
        batch.map((a) => this.lidarr.track.listByAlbum(a.id).catch(() => [] as LidarrTrack[])),
      );
      batch.forEach((a, idx) => result.set(a.id, fetched[idx]));
    }

    return result;
  }

  private fetchLocalAlbums(artistId: string): Array<{ id: string; name: string }> {
    return this.db
      .query<{ id: string; name: string }, [string]>(
        'SELECT id, name FROM library_albums WHERE artist_id = ? AND hidden = 0',
      )
      .all(artistId);
  }

  private fetchLocalSongs(artistId: string): Array<{ album_id: string; title: string }> {
    return this.db
      .query<{ album_id: string; title: string }, [string]>(
        `SELECT s.album_id, s.title
         FROM library_songs s
         JOIN library_albums a ON a.id = s.album_id
         WHERE a.artist_id = ? AND s.hidden = 0`,
      )
      .all(artistId);
  }

  private buildDiscographyAlbum(
    lidarrAlbum: LidarrAlbum,
    tracks: LidarrTrack[],
    localAlbums: Array<{ id: string; name: string }>,
    localSongs: Array<{ album_id: string; title: string }>,
  ): DiscographyAlbum {
    const normalizedTitle = normalizeTitle(lidarrAlbum.title);
    const matchedLocal = localAlbums.find(
      (a) => normalizeTitle(a.name) === normalizedTitle,
    );

    const localAlbumSongs = matchedLocal
      ? localSongs.filter((s) => s.album_id === matchedLocal.id)
      : [];

    const localNormalizedTitles = new Set(localAlbumSongs.map((s) => normalizeTitle(s.title)));
    const totalTracks = lidarrAlbum.statistics?.totalTrackCount ?? tracks.length;

    let localTrackCount = 0;
    const discographyTracks: DiscographyTrack[] = tracks.map((t) => {
      const matched = localNormalizedTitles.has(normalizeTitle(t.title));
      if (matched) localTrackCount++;
      return {
        lidarrId: t.id,
        title: t.title,
        trackNumber: t.trackNumber,
        duration: t.duration,
        hasFile: matched,
      };
    });

    let status: AlbumStatus = 'missing';
    if (tracks.length === 0 && matchedLocal) {
      // Lidarr track fetch failed/empty — we can't match per-track, so fall back
      // to album-name presence using the local song count vs the album's total.
      localTrackCount = localAlbumSongs.length;
      status = localTrackCount >= totalTracks ? 'present' : 'partial';
    } else if (matchedLocal && localTrackCount >= totalTracks) {
      status = 'present';
    } else if (localTrackCount > 0) {
      status = 'partial';
    }

    return {
      lidarrId: lidarrAlbum.id,
      foreignAlbumId: lidarrAlbum.foreignAlbumId,
      title: lidarrAlbum.title,
      releaseDate: lidarrAlbum.releaseDate,
      albumType: lidarrAlbum.albumType,
      secondaryTypes: lidarrAlbum.secondaryTypes ?? [],
      totalTracks,
      localTrackCount,
      status,
      localAlbumId: matchedLocal?.id,
      coverArtUrl: pickCoverArt(lidarrAlbum),
      tracks: discographyTracks,
    };
  }
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    // Strip leading track numbers: "01 - ", "1. ", "01."
    .replace(/^\d+[\s.\-]+/, '')
    // Strip common suffixes like "(Remastered)", "[Live]", "(Deluxe Edition)"
    .replace(/[\[(][^\])]*(remaster|deluxe|edition|version|live|bonus)[^\])]*[\])]/gi, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickCoverArt(album: LidarrAlbum): string | undefined {
  const images = album.images ?? [];
  const cover = images.find((i) => i.coverType === 'cover') ?? images[0];
  return cover?.remoteUrl ?? cover?.url;
}

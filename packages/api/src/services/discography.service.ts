import type { Database } from 'bun:sqlite';
import type { Lidarr, LidarrAlbum, LidarrTrack } from '@nicotind/lidarr-client';
import { createLogger, normalizeTitle } from '@nicotind/core';
import { addArtistFromLookup } from './lidarr-provision.js';
import { corroboratesLidarrHit } from './lidarr-confidence.js';
import { normalizeArtistForGrouping, normalizeForGrouping } from './album-grouping.js';

const log = createLogger('discography');

/**
 * Three comparisons, three normalizers — the same split `library-completeness.ts`
 * already uses for the identical "do I already own this?" question (issue #662):
 *
 *  - **artist names** → `normalizeArtistForGrouping`: folds diacritics + case but
 *    keeps punctuation, because "Miranda!" and "Miranda" are different acts.
 *  - **album titles** → `normalizeForGrouping`: additionally drops edition
 *    qualifiers, so a local "Hot Space" answers Lidarr's "Hot Space (Deluxe)".
 *  - **track titles** → `normalizeTitle`: folds and strips leading track numbers.
 *
 * This file used to declare one local `normalizeTitle` for all three, and that
 * copy stripped `[^\w\s]` *without* folding first — so an accent was deleted
 * rather than folded ("Canción" → "cancin", not "cancion"). Lidarr metadata and
 * local file tags routinely disagree about accents, so an album you owned was
 * reported missing whenever only one side carried them.
 */

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
      (a) => normalizeArtistForGrouping(a.artistName) === normalizeArtistForGrouping(artistName),
    );

    if (existing) {
      this.upsertLink(artistId, existing.id, existing.foreignArtistId);
      return existing.id;
    }

    // Lookup via MusicBrainz
    const candidates = await this.lidarr.artist.lookup(artistName);
    const best = candidates[0];
    if (!best) throw new Error(`Lidarr found no artist matching "${artistName}"`);

    // ── issue #212 direction 2 — garbage-artist provision guard ──────────────────
    // Prod bug: a delimiter-less mash ("2 MinutosTruenoDie Toten Hosen") was looked
    // up whole and Lidarr fuzzy-returned the junk artist "2", which was then *added*,
    // polluting the Lidarr library and producing wrong-artist tiles/metadata.
    //
    // `segmentConcatenatedArtist` (artist-split.ts) is the root-cause fix, but it is
    // confirmation-gated: a mash whose members appear nowhere else in the library
    // stays whole, and that whole string still reaches this lookup. So this guard is
    // the backstop for exactly the case the segmenter is designed to decline.
    //
    // A bare "returned name must equal the query" check would RE-BREAK #211/#217,
    // which deliberately widened matching to accept canonical-name drift (library
    // `Eduardo Miño` → Lidarr `Luis Eduardo Miño Naranjo`). `corroboratesLidarrHit`
    // owns that policy — see lidarr-confidence.ts for why it is name-only (the
    // lookup endpoint ships no albumCount/statistics to corroborate against).
    if (!corroboratesLidarrHit(artistName, best)) {
      // Never regress an artist that already resolved. A stale cache entry means we
      // resolved this artist before (possibly under looser rules, possibly to a
      // correct-but-name-unguessable canonical like "El Puma Rodríguez" → "José Luis
      // Rodríguez"). Refusing here would turn a working discography page into a 500,
      // so an existing link wins over a fresh uncorroborated hit — the guard only
      // ever blocks *new* provisioning, which is the pollution #212 is about.
      if (cached?.lidarr_id) {
        log.warn(
          { artistName, candidate: best.artistName, lidarrId: cached.lidarr_id },
          'Uncorroborated Lidarr hit — keeping the existing link',
        );
        this.db.run('UPDATE artist_discography_links SET checked_at = ? WHERE artist_id = ?', [
          Date.now(),
          artistId,
        ]);
        return cached.lidarr_id;
      }

      log.warn(
        { artistName, candidate: best.artistName },
        'Refusing to provision unconfirmed Lidarr artist',
      );
      throw new Error(`No confident Lidarr match for "${artistName}"`);
    }

    const added = await addArtistFromLookup(this.lidarr, best, this.musicDir);

    this.upsertLink(artistId, added.id, added.foreignArtistId);
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

  private async fetchAllTracks(albums: LidarrAlbum[]): Promise<Map<number, LidarrTrack[]>> {
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

  /**
   * Albums with at least one *landed* song — i.e. something the user can actually
   * see and play. A quarantined song is hidden from every album surface
   * (`quarantineExclusion`), so counting it as owned here made the two halves of
   * the artist page contradict each other: "0 albums" in the header beside
   * "10/10 tracks · 1 complete" in the discography strip (issue #692 / #687).
   * Presence is graded by landed songs rather than the album row alone, so the
   * album-name fallback below can't report a wholly-quarantined album as present.
   */
  private fetchLocalAlbums(artistId: string): Array<{ id: string; name: string }> {
    return this.db
      .query<{ id: string; name: string }, [string]>(
        `SELECT id, name FROM library_albums
          WHERE artist_id = ? AND hidden = 0
            AND EXISTS (
              SELECT 1 FROM library_songs s
               WHERE s.album_id = library_albums.id AND s.landed_at IS NOT NULL
            )`,
      )
      .all(artistId);
  }

  /** Only landed songs count as owned — see {@link fetchLocalAlbums}. A partly
   *  landed album therefore reads as *partial*, which is the honest answer: those
   *  are the tracks that exist for the user right now. */
  private fetchLocalSongs(artistId: string): Array<{ album_id: string; title: string }> {
    return this.db
      .query<{ album_id: string; title: string }, [string]>(
        `SELECT s.album_id, s.title
         FROM library_songs s
         JOIN library_albums a ON a.id = s.album_id
         WHERE a.artist_id = ? AND s.hidden = 0 AND s.landed_at IS NOT NULL`,
      )
      .all(artistId);
  }

  private buildDiscographyAlbum(
    lidarrAlbum: LidarrAlbum,
    tracks: LidarrTrack[],
    localAlbums: Array<{ id: string; name: string }>,
    localSongs: Array<{ album_id: string; title: string }>,
  ): DiscographyAlbum {
    const normalizedTitle = normalizeForGrouping(lidarrAlbum.title);
    const matchedLocal = localAlbums.find((a) => normalizeForGrouping(a.name) === normalizedTitle);

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

function pickCoverArt(album: LidarrAlbum): string | undefined {
  const images = album.images ?? [];
  const cover = images.find((i) => i.coverType === 'cover') ?? images[0];
  return cover?.remoteUrl ?? cover?.url;
}

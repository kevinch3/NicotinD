/** Release-type taxonomy shared with the album/single classification model. */
export type MetadataReleaseType = 'album' | 'ep' | 'single' | 'compilation';

/**
 * A candidate release returned by the user-driven metadata fix search (Lidarr /
 * MusicBrainz lookup against an editable query). The user confirms one to
 * overwrite an album's artist/title/cover/year/type — low-confidence hits are
 * surfaced too (sorted by `score`) so a mis-tagged album can still be fixed.
 */
export interface MetadataCandidate {
  /** MusicBrainz release-group id (`foreignAlbumId`), for reference. */
  releaseGroupId: string | null;
  artist: string;
  title: string;
  year: number | null;
  releaseType: MetadataReleaseType | null;
  coverUrl: string | null;
  /** 0–100 match confidence against the search query (diacritic-insensitive). */
  score: number;
}

/** Body for `POST /api/library/albums/:id/metadata` — apply a confirmed fix. */
export interface ApplyMetadataRequest {
  artist?: string;
  album?: string;
  year?: number;
  coverUrl?: string;
  releaseType?: MetadataReleaseType;
  /** Whether the values came from a Lidarr candidate or free-text entry. */
  source?: 'lidarr' | 'manual';
}

/** A persisted, user-confirmed correction keyed on the scanner's raw albumId. */
export interface MetadataOverride {
  artist?: string;
  album?: string;
  year?: number;
}

/** Where a selectable album cover comes from in the cover picker. */
export type CoverCandidateSource = 'current' | 'lidarr' | 'file';

/**
 * One selectable cover in the Fix-metadata cover picker. `url` is always a
 * renderable thumbnail; `file` covers also carry the `songId` the embedded
 * image was read from so applying one can materialize it as the album cover.
 */
export interface AlbumCoverCandidate {
  source: CoverCandidateSource;
  url: string;
  label: string;
  /** Set only for `source:'file'` — the song whose embedded art this is. */
  songId?: string;
}

/** Response of `GET /api/library/albums/:id/cover-candidates`. */
export interface CoverCandidatesResponse {
  current: AlbumCoverCandidate | null;
  lidarr: AlbumCoverCandidate[];
  files: AlbumCoverCandidate[];
}

/**
 * Body for `POST /api/library/albums/:id/cover` — apply only the cover, leaving
 * artist/album/year untouched. Exactly one of `coverUrl` (Lidarr alt / custom
 * URL) or `songId` (an album track's embedded art → written as folder cover) is
 * provided.
 */
export interface ApplyCoverRequest {
  coverUrl?: string;
  songId?: string;
}

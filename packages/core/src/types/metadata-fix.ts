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

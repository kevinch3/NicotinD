// Web-local request/response shapes for the domain API services. These are not
// @nicotind/core schemas — they describe the API surface the Angular app talks
// to. Split out of the former monolithic api.service.ts so the per-domain
// services and their consumers share one types module.

export interface ArtistCredit {
  id: string;
  name: string;
  role: 'primary' | 'featuring';
}

export interface SetupStatus {
  needsSetup: boolean;
}

export interface SetupResult {
  token: string;
  user: { id: string; username: string; role: string };
  needsRestart?: boolean;
}

export interface SetupBody {
  admin: { username: string; password: string };
  soulseek?: { username: string; password: string };
  musicDir?: string;
  transcodeLossless?: { enabled?: boolean; bitRate?: number };
  lidarr?: { url?: string; apiKey?: string };
}

export interface AuthResult {
  token: string;
  user: { id: string; username: string; role: string };
}

export interface SearchResult {
  searchId: string;
  local: {
    artists: Array<{ id: string; name: string; albumCount?: number }>;
    albums: Array<{
      id: string;
      name: string;
      artist: string;
      coverArt?: string;
      songCount?: number;
      year?: number;
      classification?: 'album' | 'ep' | 'single' | 'compilation' | 'unknown';
      artists?: ArtistCredit[];
    }>;
    songs: Array<{
      id: string;
      title: string;
      artist: string;
      artistId?: string;
      album: string;
      duration?: number;
      coverArt?: string;
      track?: number;
    }>;
  };
  network: null;
  networkAvailable?: boolean;
  errors?: string[];
}

export interface NetworkResults {
  state: 'searching' | 'complete';
  responseCount: number;
  canBrowse?: boolean;
  results: Array<{
    username: string;
    freeUploadSlots: number;
    uploadSpeed: number;
    queueLength?: number;
    files: Array<{
      filename: string;
      size: number;
      bitRate?: number;
      length?: number;
      title?: string;
      artist?: string;
      album?: string;
      trackNumber?: string;
    }>;
  }>;
}

export interface Album {
  id: string;
  name: string;
  artist: string;
  artistId?: string;
  artists?: ArtistCredit[];
  coverArt?: string;
  songCount?: number;
  year?: number;
  genre?: string;
  duration?: number;
  created?: string;
  /** ISO timestamp when starred, absent otherwise. */
  starred?: string;
  classification?: 'album' | 'ep' | 'single' | 'compilation' | 'unknown';
  hidden?: boolean;
}

export interface AlbumDetail {
  id: string;
  name: string;
  artist: string;
  artistId?: string;
  artists?: ArtistCredit[];
  coverArt?: string;
  year?: number;
  song: Array<{
    id: string;
    title: string;
    artist: string;
    artistId?: string;
    artists?: ArtistCredit[];
    albumId?: string;
    duration?: number;
    track?: number;
    coverArt?: string;
  }>;
}

export interface ProvenanceRecord {
  action: string;
  detail: {
    from?: string;
    to?: string;
    kept?: string;
    mb_recording_id?: string;
    mb_release_id?: string;
    mb_album_title?: string;
    mb_artist_name?: string;
    reason?: string;
  };
  appliedAt: number;
}

export interface Song {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  artists?: ArtistCredit[];
  albumArtist?: string;
  albumArtistId?: string;
  album: string;
  albumId: string;
  duration?: number;
  track?: number;
  coverArt?: string;
  path: string;
  bitRate: number;
  size: number;
  created: string;
  genre?: string;
  /** Full genre set, primary first (from library_song_genres). */
  genres?: string[];
  year?: number;
  /** ISO timestamp when starred, absent otherwise. */
  starred?: string;
  bpm?: number;
  key?: string;
  /** Perceived energy 0..1 (server enrichment). */
  energy?: number;
  /** Integrated loudness in LUFS. */
  loudness?: number;
  /** Musical positivity 0..1. */
  valence?: number;
  /** Danceability 0..1. */
  danceability?: number;
  /** Acoustic confidence 0..1. */
  acousticness?: number;
  /** Probability the track is instrumental 0..1. */
  instrumental?: number;
  /** Dominant mood label (happy|sad|aggressive|relaxed|party). */
  mood?: string;
}

export interface StreamingSettings {
  transcodeEnabled: boolean;
  format: 'mp3' | 'opus' | 'aac';
  maxBitRate: number;
  forceTranscode: boolean;
  ffmpegAvailable?: boolean;
}

export interface UserDir {
  name: string;
  fileCount: number;
  files: Array<{ filename: string; size: number; bitRate?: number; length?: number }>;
}

/** Filesystem usage (bytes) for the disk holding the music dir. */
export interface DiskUsage {
  total: number;
  free: number;
  used: number;
}

export type BrowseJobResult =
  { state: 'pending' } | { state: 'complete'; dirs: UserDir[] } | { state: 'error'; error: string };

export interface AdminUser {
  id: string;
  username: string;
  role: string;
  status: string;
  created_at: string;
  // Ephemeral presence, merged server-side from PresenceService (see docs/presence-tracking.md).
  isConnected: boolean;
  amountOfDevices: number;
  amountOfSessions: number;
}

export type PlaylistKind = 'user' | 'curated';

export interface PlaylistSummary {
  id: string;
  name: string;
  description: string | null;
  songCount: number;
  /** Designed gradient cover URL (e.g. /playlist-covers/<slug>.svg), or null. */
  coverArt: string | null;
  /** `curated` = system-seeded, global, read-only; `user` = the user's own. */
  kind: PlaylistKind;
  createdAt: number;
  modifiedAt: number;
}

export interface PlaylistDetail extends PlaylistSummary {
  songs: Song[];
}

export interface AlbumJob {
  id: number;
  lidarrAlbumId: number | null;
  artistName: string | null;
  albumTitle: string | null;
  username: string;
  directory: string;
  state: string;
  fallbackAttempts: number;
  createdAt: number;
}

export interface UntrackedDownload {
  transferKey: string;
  username: string;
  directory: string;
  filename: string;
  basename: string;
  completedAt: number;
}

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
  status: 'present' | 'partial' | 'missing';
  localAlbumId?: string;
  coverArtUrl?: string;
  tracks: DiscographyTrack[];
}

export interface DiscographyResult {
  artistId: string;
  lidarrId: number;
  mbid: string;
  albums: DiscographyAlbum[];
}

export interface HuntFile {
  filename: string;
  size: number;
  bitRate?: number;
}

export interface FolderCandidate {
  directory: string;
  username: string;
  files: HuntFile[];
  matchedTracks: number;
  totalTracks: number;
  matchPct: number;
  format: string;
  estimatedSizeMb: number;
  isLive: boolean;
  freeUploadSlots: number;
  queueLength: number;
  uploadSpeed: number;
}

export interface HuntResult {
  candidates: FolderCandidate[];
  totalTracks: number;
  skewNeeded?: boolean;
}

export interface CatalogArtist {
  mbid: string;
  name: string;
  imageUrl?: string;
  type?: string;
}

export interface CatalogAlbum {
  foreignAlbumId: string;
  title: string;
  artistName: string;
  artistMbid: string;
  year?: string;
  albumType: string;
  secondaryTypes: string[];
  coverUrl?: string;
  trackCount: number;
}

export interface CatalogSearchResult {
  artists: CatalogArtist[];
  albums: CatalogAlbum[];
  /** The artist the album cards were scoped to, when the query named one. */
  scopedArtist?: string;
  /** Artist matched but the catalog had none of their albums — fall back to the
   *  network lane. See docs/e2e-playground-findings-2026-06.md §A6. */
  discographyUnavailable?: boolean;
}

export interface CatalogResolveResult {
  lidarrAlbumId: number;
  totalTracks: number;
  title: string;
  artistName: string;
}

/** Per-track processing-step state for the admin quarantine queue. Mirrors the
 *  API's song-steps.ts. `done` = value produced, `skipped` = permanently failed
 *  (won't block landing), `pending` = still to run. */
export type StepState = 'done' | 'pending' | 'skipped';

export interface SongSteps {
  download: 'done';
  bpm: StepState;
  key: StepState;
  energy: StepState;
  genre: StepState;
  mood: StepState;
}

export interface QuarantineSong {
  id: string;
  title: string;
  track: number | null;
  steps: SongSteps;
}

export interface QuarantineAlbum {
  albumId: string;
  albumTitle: string;
  albumArtist: string;
  songs: QuarantineSong[];
}

// ── Device pairing (QR link) + remote access ─────────────────────────────────

/** Guided remote-access state machine (Tailscale Funnel), mirrored from the
 *  API's tailscale.ts RemoteAccessState. */
export type RemoteAccessState =
  | { kind: 'not-installed' }
  | { kind: 'needs-login'; authUrl?: string }
  | { kind: 'needs-operator'; command: string }
  | { kind: 'funnel-not-enabled'; enableUrl?: string }
  | { kind: 'inactive'; publicUrl?: string }
  | { kind: 'active'; publicUrl: string }
  | { kind: 'error'; detail: string };

export interface RemoteAccessStatus {
  enabled: boolean;
  state: RemoteAccessState;
}

export interface PairingMintResponse {
  token: string;
  code: string;
  expiresAt: number;
  name: string;
  /** Candidate server URLs the phone probes in order (funnel first). */
  urls: string[];
  remoteAccess: RemoteAccessStatus | null;
}

export interface PairedDevice {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
  lastSeenAt: number | null;
  current: boolean;
}

// ── Library fragmentation diagnostic (admin) ──────────────────────────────
//
// `GET /api/library/fragments` reports the three defect classes that turn
// "all tracks are present in the library" into "the album card never
// surfaces" — same-release rows split across album-artist spellings, rows
// hidden from the grid by `hidden`/`classification`, and one-track-per-title
// mis-splits. The Admin panel + `scripts/check-fragments.ts` CLI both render
// this shape. → `docs/library-scanner.md` "Fragmentation diagnostic".

export interface LibraryDuplicateAlbumCluster {
  normalizedTitle: string;
  displayTitle: string;
  memberIds: string[];
  artistSpellings: Array<{ name: string; occurrences: number }>;
  totalSongs: number;
}

export interface LibraryHiddenByClassification {
  albumId: string;
  name: string;
  artist: string;
  classification: string;
  hidden: boolean;
  songCount: number;
  reason: 'hidden' | 'unknown' | 'oversized';
}

export interface LibraryFragmentFinding {
  rule: string;
  severity: 'high' | 'medium' | 'low';
  subject: string;
  message: string;
}

/** Cached server update-check vs the running version (admin). */
export interface UpdateCheck {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: number | null;
  releaseUrl: string | null;
  versionHistory: { version: string; firstSeenAt: number }[];
}

/** One backup under `<dataDir>/backups` (DB snapshot + secrets). */
export interface BackupInfo {
  name: string;
  createdAt: number;
  sizeBytes: number;
  files: string[];
}

export interface LibraryFragmentReport {
  duplicateAlbums: LibraryDuplicateAlbumCluster[];
  hiddenByClassification: LibraryHiddenByClassification[];
  misSplitAlbums: LibraryFragmentFinding[];
  totals: { duplicateAlbums: number; hiddenByClassification: number; misSplitAlbums: number };
  ok: boolean;
}

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
  /** Rights/licence code (LICENCE_VOCAB, e.g. 'public-domain'/'cc-by'). Absent = unknown. */
  licence?: string;
}

export interface StreamingSettings {
  transcodeEnabled: boolean;
  format: 'mp3' | 'opus' | 'aac';
  maxBitRate: number;
  forceTranscode: boolean;
  ffmpegAvailable?: boolean;
}

/** Read-only download-pipeline prefs the acquire UI reads to show an accurate
 *  "lossless → Opus" reminder. `enabled && ffmpegAvailable` gates the hint. */
export interface DownloadSettings {
  transcodeLossless: { enabled: boolean; format: 'opus'; bitRate: number };
  ffmpegAvailable: boolean;
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

/** One admin audit-log entry (destructive/curation action record). */
export interface AuditEntry {
  id: number;
  at: number;
  userId: string;
  username: string | null;
  action: string;
  targetKind: string | null;
  targetId: string | null;
  detail: string | null;
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

// ── ServiceReview (admin) ────────────────────────────────────────────────────
//
// `GET /api/admin/review` returns one consolidated snapshot of everything the
// Admin page needs to glance at: hardware metrics (CPU/GPU/mem), slskd state,
// library scan, update check, backups, processing summary, incomplete-job +
// untracked counts, and the recent audit tail. The Admin page renders this as
// its single source of truth — every section reads from one signal — and the
// service singleton polls it on a 5s tick with Page-Visibility pause. → See
// `docs/design-patterns.md` "ServiceReview".

/** GPU vendor string (vendor CLI identifier we successfully parsed). */
export type GpuVendor = 'nvidia' | 'amd' | 'apple' | 'intel' | 'unknown';

export interface CpuSnapshot {
  /** 0..100 system-wide utilisation since the previous snapshot. */
  percent: number;
  /** Total logical cores (incl. hyperthreads). */
  cores: number;
  /** CPU model string, trimmed. */
  model: string;
}

export interface MemorySnapshot {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** NicotinD process RSS — what the server is actually holding. */
  processRssBytes: number;
  /** NicotinD process V8 heap-used — distinct from RSS. */
  processHeapBytes: number;
}

export interface GpuSnapshot {
  vendor: GpuVendor;
  /** 0..100, undefined when the vendor CLI doesn't expose utilisation (Apple). */
  percent?: number;
  /** Display name from the vendor tool. */
  name?: string;
  /** Bytes, undefined when not exposed. */
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
}

export interface HardwareSnapshot {
  cpuModel: string;
  cores: number;
  arch: 'x64' | 'arm64' | 'arm';
  platform: 'linux' | 'darwin' | 'win32';
  totalMemoryBytes: number;
  gpuDetected: { vendor: GpuVendor; name?: string } | null;
}

export interface BackupsSummary {
  total: number;
  totalBytes: number;
  newestAt: number | null;
  lastBackupName: string | null;
}

/** Same shape the SSE stream publishes; reduced to a static snapshot here. */
export interface ProcessingSummary {
  phase: 'idle' | 'running' | 'outside-window' | 'disabled';
  currentTask: string | null;
  processed: number;
  failed: number;
  total: number;
  skipped: number;
  quarantined: number;
  taskPending: Record<string, number>;
  availability: Record<string, true | string>;
  startedAt: string | null;
  updatedAt: string | null;
}

/** Compact album-job row for the Admin Incomplete-Albums table. */
export interface IncompleteAlbumJob {
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

/** Compact untracked-download row for the Admin Untracked-Downloads table. */
export interface UntrackedDownload {
  transferKey: string;
  username: string;
  directory: string;
  filename: string;
  basename: string;
  completedAt: number;
}

export interface ServiceReview {
  collectedAt: number;
  version: string;
  uptimeMs: number;
  hardware: HardwareSnapshot;
  load: {
    cpu: CpuSnapshot;
    memory: MemorySnapshot;
    gpu: GpuSnapshot | null;
  };
  services: {
    slskd: {
      configured: boolean;
      healthy: boolean;
      connected: boolean;
      username?: string;
      version?: string;
      uptime?: number;
    };
  };
  library: { scanning: boolean; indexedSongCount: number };
  updateCheck: UpdateCheck | null;
  /** Full backup list (newest first) — drives the Admin backups table. */
  backups: BackupInfo[];
  /** Compact summary for the collapsed header chip. */
  backupsSummary: BackupsSummary;
  processing: ProcessingSummary | null;
  incompleteJobsCount: number;
  untrackedCount: number;
  auditTail: AuditEntry[];
  incompleteJobs: IncompleteAlbumJob[];
  untracked: UntrackedDownload[];
  /** Human-readable sub-fetch errors the snapshot degraded around. */
  errors: string[];
}

export interface LibraryFragmentReport {
  duplicateAlbums: LibraryDuplicateAlbumCluster[];
  hiddenByClassification: LibraryHiddenByClassification[];
  misSplitAlbums: LibraryFragmentFinding[];
  totals: { duplicateAlbums: number; hiddenByClassification: number; misSplitAlbums: number };
  ok: boolean;
}

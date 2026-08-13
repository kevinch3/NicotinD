// Re-export only browser-safe types from @nicotind/core
// (The core package barrel also exports Bun-specific utils that Angular can't compile)
export type {
  AcquireBackend,
  AcquireJobState,
  AcquireJob,
  AcquisitionJobKind,
  AcquisitionJobView,
  AcquisitionMethod,
  PipelineStage,
  SongAcquisition,
  TrackStatus,
} from '../../../core/src/types/acquire';

export type { ArchiveCandidate } from '../../../core/src/types/archive';

export type {
  AcquisitionCandidate,
  AcquisitionSourceId,
  AcquisitionKind,
  AcquireIntent,
} from '../../../core/src/types/acquisition-candidate';

export type { SpotifyCandidate } from '../../../core/src/types/spotify';

export type {
  BpmAnalysisResult,
  GenreSuggestion,
  LicenceSuggestion,
} from '../../../core/src/types/track-analysis';

export type { ArtistInfoResponse } from '../../../core/src/types/artist-info';

export type {
  ProcessingTaskId,
  ProcessingWindow,
  ProcessingSettings,
  ProcessingPhase,
  ProcessingStatus,
} from '../../../core/src/types/processing';

export type {
  MetadataReleaseType,
  MetadataCandidate,
  ApplyMetadataRequest,
  MetadataOverride,
  CoverCandidateSource,
  AlbumCoverCandidate,
  CoverCandidatesResponse,
  ApplyCoverRequest,
} from '../../../core/src/types/metadata-fix';

export type { LyricsDto } from '../../../core/src/types/lyrics';

export type {
  GenerationFeedbackResourceType,
  GenerationVerdict,
  FolderRef,
  HuntMatchItemFlags,
  HuntMatchInput,
  SnapshotFolderCandidate,
  HuntMatchOutput,
  HuntMatchSnapshot,
  GenerationFeedbackRecord,
  GenerationFeedbackSummary,
  ResolveFeedbackBody,
  HuntMatchFixture,
} from '../../../core/src/types/generation-feedback';

// Value re-export (not just types): library-filter is a pure, browser-safe
// module (model + serialization + Camelot/mood vocab) shared with the API.
export * from '../../../core/src/types/library-filter';

// Value re-export: licence vocabulary (codes/labels/badges + normalizeLicence),
// a pure, browser-safe module shared with the API scanner + filter.
export * from '../../../core/src/types/licence';

// Value re-export: role ladder helpers (pure, browser-safe) shared with the API.
export * from '../../../core/src/roles';

// Value re-export: version comparison (pure) — shared with the server update-check
// and the native APK self-update.
export * from '../../../core/src/version';

// Value re-export: slskd hunt query builders (pure, browser-safe) — the single
// source the album-hunt modal shows and the API hunter fires. See hunt-queries.ts.
export * from '../../../core/src/hunt-queries';

// Value re-export: pairing / TV sign-in code alphabet (pure, browser-safe) —
// the API mints codes with it, the Settings scan button validates against it
// (issue #434), so the two can't drift.
export * from '../../../core/src/pairing-code';

/** AcoustID fingerprint-identify result shape (issue #411 download-review). */
export type { IdentifyResult } from '../../../core/src/plugin/capabilities';
/** Why an identify attempt produced no match (issue #414) — re-exported from
 *  the same source rather than re-declared, so the taxonomy can't drift. */
export type { IdentifyOutcome, IdentifyFailureKind } from '../../../core/src/plugin/capabilities';

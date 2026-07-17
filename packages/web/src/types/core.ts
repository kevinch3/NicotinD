// Re-export only browser-safe types from @nicotind/core
// (The core package barrel also exports Bun-specific utils that Angular can't compile)
export type {
  SlskdUserTransferGroup,
  SlskdTransfer,
  SlskdTransferDirectory,
  SlskdTransferState,
  SlskdFile,
  SlskdSearchResponse,
  SlskdServerState,
  SlskdStatus,
  SlskdSpeeds,
  SlskdTransferCounts,
  SlskdLimits,
  SlskdShareStats,
} from '../../../core/src/types/slskd';

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

export type { BpmAnalysisResult, GenreSuggestion } from '../../../core/src/types/track-analysis';

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

// Value re-export (not just types): library-filter is a pure, browser-safe
// module (model + serialization + Camelot/mood vocab) shared with the API.
export * from '../../../core/src/types/library-filter';

// Value re-export: role ladder helpers (pure, browser-safe) shared with the API.
export * from '../../../core/src/roles';

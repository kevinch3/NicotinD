// Re-export only browser-safe types from @nicotind/core
// (The core package barrel also exports Bun-specific utils that Angular can't compile)
export type {
  SlskdUserTransferGroup,
  SlskdTransfer,
  SlskdTransferDirectory,
  SlskdTransferState,
  SlskdFile,
  SlskdSearchResponse,
} from '../../../core/src/types/slskd';

export type {
  AcquireBackend,
  AcquireJobState,
  AcquireJob,
  AcquisitionMethod,
  PipelineStage,
  SongAcquisition,
} from '../../../core/src/types/acquire';

export type { ArchiveCandidate } from '../../../core/src/types/archive';

export type { SpotifyCandidate } from '../../../core/src/types/spotify';

export type {
  BpmAnalysisResult,
  GenreSuggestion,
} from '../../../core/src/types/track-analysis';

export type {
  MetadataReleaseType,
  MetadataCandidate,
  ApplyMetadataRequest,
  MetadataOverride,
} from '../../../core/src/types/metadata-fix';

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

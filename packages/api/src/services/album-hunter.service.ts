// Moved to @nicotind/slskd-addon (acquisition addon protocol phase 1, #488).
// This shim keeps existing api import paths working until the phase-3 severing.
export {
  AlbumHunterService,
  scoreFolders,
  isBloatedFolder,
  singleMatchStrength,
  normalizeTitle,
  titlesOverlap,
  buildSkewedQueries,
  stripTitleQualifiers,
  baseQueries,
  type CanonicalTrackRef,
  type FolderCandidate,
  type HuntFile,
  type ScoreResponse,
} from '@nicotind/slskd-addon';

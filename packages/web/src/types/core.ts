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

export type {
  ImportJob,
  ImportJobDir,
  ImportJobState,
  ImportJobSummary,
  ImportPreview,
  ImportSourceErrorCode,
} from '../../../core/src/types/import';

export type { ArchiveCandidate } from '../../../core/src/types/archive';

// A *value*, not a type: the upload allowlist runs in the browser to filter a
// drop before it costs bandwidth, and on the server to enforce it. Importing
// the same function is what keeps the two from drifting into "uploaded, then
// silently discarded". Free of node builtins on purpose so it is safe here.
export { isUploadableName } from '../../../core/src/upload-allowlist';

export type {
  AcquisitionCandidate,
  AcquisitionSourceId,
  AcquisitionKind,
  AcquireIntent,
} from '../../../core/src/types/acquisition-candidate';

export type { SpotifyCandidate } from '../../../core/src/types/spotify';

export type { BpmAnalysisResult, GenreSuggestion } from '../../../core/src/types/track-analysis';

export type { ArtistInfoResponse } from '../../../core/src/types/artist-info';

export type {
  ProcessingTaskId,
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
// *Values*, not types: the nudge control and the API both bound the offset, and
// both must bound it the same way or the UI promises a range the server refuses.
export { LYRICS_OFFSET_MAX_MS, LYRICS_OFFSET_STEP_MS } from '../../../core/src/types/lyrics';
// The LRC parser and the render-time offset. Pure string/array work with no node
// builtins, and shared so the karaoke surfaces and the API's health detector
// cannot disagree about where a line falls — in particular about the sign of the
// spec's own `[offset:]` tag.
export {
  parseLrc,
  parseLrcDetailed,
  applyLyricsOffset,
  findActiveLine,
} from '../../../core/src/lrc';
export type { LyricLine, ParsedLrc } from '../../../core/src/lrc';
export type { WaveformData } from '../../../core/src/types/waveform';

export type {
  RadioPollVerdict,
  PollRating,
  RadioPollVoteScale,
  RadioPollSettings,
  RadioPollScenarioSnapshot,
  RadioPollCandidateSnapshot,
  RadioPollExplanation,
  PublicPollTrack,
  PublicPollScenario,
  PublicPollView,
  PublicPollVoteBody,
  RadioPollSummary,
  RadioPollCandidateResult,
  RadioPollScenarioResult,
  RadioPollResults,
} from '../../../core/src/types/radio-poll';

// Value re-export (not just types): library-filter is a pure, browser-safe
// module (model + serialization + Camelot/mood vocab) shared with the API.
export * from '../../../core/src/types/library-filter';
// How a radio generation actually scored (#1124) — types only, shared so the
// chip cannot describe a shape the route does not send.
export * from '../../../core/src/types/radio-provenance';
// Named recommendation strategies + the variety control's vocabulary — pure,
// browser-safe; the chip and the player both need the value exports.
export * from '../../../core/src/types/radio-strategy';
// Per-user preferences (#1299): the schema the API validates against.
export * from '../../../core/src/types/user-preferences';

// Value re-export: origin vocabulary (ISO codes, cultural regions, closeness,
// flag emoji) — pure and browser-safe like library-filter above.
export * from '../../../core/src/types/origin';

// Value re-export: role ladder helpers (pure, browser-safe) shared with the API.
export * from '../../../core/src/roles';
export * from '../../../core/src/remote-playback';

// Value re-export: version comparison (pure) — shared with the server update-check
// and the native APK self-update.
export * from '../../../core/src/version';

// Value re-export: the Downloads-card title chain (pure, browser-safe). One
// shared derivation so the API read model and the web adapter can never
// disagree about what a download is called. See docs/download-pipeline.md.
export * from '../../../core/src/utils/download-title';
export * from '../../../core/src/utils/download-failure';
export * from '../../../core/src/utils/folder-name';
export * from '../../../core/src/types/classify-acquire-url';

// Value re-export: slskd hunt query builders (pure, browser-safe) — the single
// source the album-hunt modal shows and the API hunter fires. See hunt-queries.ts.
export * from '../../../addon-sdk/src/hunt-queries';

// Value re-export: pairing / TV sign-in code alphabet (pure, browser-safe) —
// the API mints codes with it, the Settings scan button validates against it
// (issue #434), so the two can't drift.
export * from '../../../core/src/pairing-code';

/** AcoustID fingerprint-identify result shape (issue #411). */
export type { IdentifyResult } from '../../../core/src/plugin/capabilities';
/** Why an identify attempt produced no match (issue #414) — re-exported from
 *  the same source rather than re-declared, so the taxonomy can't drift. */
export type { IdentifyOutcome, IdentifyFailureKind } from '../../../core/src/plugin/capabilities';

// Value re-export: addon capability → plain-language consent risk lines
// (pure, browser-safe) — the single source both the consent dialog and the
// published protocol spec render from. See addon-capability-risk.ts.
export * from '../../../addon-sdk/src/addon-capability-risk';

// Value re-export: the curated addon catalog + compose-snippet renderer (issue
// #517, pure + browser-safe) — the Extensions marketplace renders install cards
// and the paste-able snippet from the same source the API route serves.
export * from '../../../core/src/addon-catalog';

// Track reports (issue #987). The reason list and the taste-only rule are
// *values*, not just types: the dialog renders the same closed set the route
// validates against, and both sides decide "does this become a curation flag?"
// with the same function — which is what stops the two drifting into a UI that
// offers a reason the server rejects. Free of node builtins on purpose.
export {
  TRACK_REPORT_REASONS,
  isTasteOnly,
  isTrackReportReason,
  trackReportReasonText,
} from '../../../core/src/types/track-report';
export type { TrackReportReason } from '../../../core/src/types/track-report';

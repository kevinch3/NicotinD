// Moved to @nicotind/slskd-addon (#488) — shim until the phase-3 severing.
// The api injects its host seam via services/fallback-host.ts.
export {
  AlbumFallbackService,
  NOOP_FALLBACK_HOST,
  type AlbumFallbackOptions,
  type AlternateCandidate,
  type FallbackHost,
  type RecordJobInput,
} from '@nicotind/slskd-addon';

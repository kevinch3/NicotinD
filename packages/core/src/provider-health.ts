/**
 * Rolling call-outcome counters for the two metadata providers (issue #670).
 *
 * Every Lidarr and MusicBrainz failure was observed exactly once — a log line at
 * the single client seam — and then degraded to `[]`/`null` by ~20 downstream
 * call sites, so an outage never reached `GET /api/admin/review`. This is the
 * aggregate that seam was missing. → docs/observability.md
 *
 * Module-level on purpose: `MusicBrainzClient` is constructed in eight places
 * while the runtime Lidarr is a single instance, so per-instance counters would
 * report whichever one the route happened to hold.
 */

export type ProviderId = 'lidarr' | 'musicbrainz';

/** Why a call failed. Only `http` carries a status. */
export type ProviderFailureKind = 'timeout' | 'http' | 'network';

export interface ProviderCallOutcome {
  ok: boolean;
  kind?: ProviderFailureKind;
  status?: number;
}

export interface ProviderHealth {
  /** Calls the provider answered — a MusicBrainz 404 is an answer, not a fault. */
  ok: number;
  failed: number;
  /** Subset of `failed` that hit the client's own budget. */
  timedOut: number;
  /** `ok / (ok + failed)`, 0-1. An idle window reads as 1 — the counts say why. */
  successRate: number;
  /** Not windowed: "it last broke an hour ago" outlives the counters. */
  lastFailureAt: number | null;
  lastFailureKind: ProviderFailureKind | null;
  lastFailureStatus: number | null;
  windowMs: number;
}

export type ProviderHealthSnapshot = Record<ProviderId, ProviderHealth>;

export const PROVIDER_HEALTH_WINDOW_MS = 15 * 60_000;
const BUCKET_MS = 60_000;
const BUCKET_COUNT = PROVIDER_HEALTH_WINDOW_MS / BUCKET_MS;

interface Bucket {
  startedAt: number;
  ok: number;
  failed: number;
  timedOut: number;
}

interface ProviderState {
  buckets: Bucket[];
  lastFailureAt: number | null;
  lastFailureKind: ProviderFailureKind | null;
  lastFailureStatus: number | null;
}

function emptyState(): ProviderState {
  return {
    // Fixed ring, not an event list: the counter must stay bounded under a
    // provider that is failing thousands of times an hour.
    buckets: Array.from({ length: BUCKET_COUNT }, () => ({
      startedAt: 0,
      ok: 0,
      failed: 0,
      timedOut: 0,
    })),
    lastFailureAt: null,
    lastFailureKind: null,
    lastFailureStatus: null,
  };
}

const state: Record<ProviderId, ProviderState> = {
  lidarr: emptyState(),
  musicbrainz: emptyState(),
};

/** @param at injected so a test can drive the window without real timers. */
export function recordProviderCall(
  provider: ProviderId,
  outcome: ProviderCallOutcome,
  at: number = Date.now(),
): void {
  const s = state[provider];
  const startedAt = at - (at % BUCKET_MS);
  const bucket = s.buckets[Math.floor(at / BUCKET_MS) % BUCKET_COUNT]!;
  if (bucket.startedAt !== startedAt) {
    bucket.startedAt = startedAt;
    bucket.ok = 0;
    bucket.failed = 0;
    bucket.timedOut = 0;
  }
  if (outcome.ok) {
    bucket.ok += 1;
    return;
  }
  bucket.failed += 1;
  if (outcome.kind === 'timeout') bucket.timedOut += 1;
  s.lastFailureAt = at;
  s.lastFailureKind = outcome.kind ?? null;
  s.lastFailureStatus = outcome.status ?? null;
}

function health(s: ProviderState, at: number): ProviderHealth {
  let ok = 0;
  let failed = 0;
  let timedOut = 0;
  for (const b of s.buckets) {
    if (at - b.startedAt >= PROVIDER_HEALTH_WINDOW_MS) continue;
    ok += b.ok;
    failed += b.failed;
    timedOut += b.timedOut;
  }
  const calls = ok + failed;
  return {
    ok,
    failed,
    timedOut,
    successRate: calls === 0 ? 1 : ok / calls,
    lastFailureAt: s.lastFailureAt,
    lastFailureKind: s.lastFailureKind,
    lastFailureStatus: s.lastFailureStatus,
    windowMs: PROVIDER_HEALTH_WINDOW_MS,
  };
}

export function providerHealthSnapshot(at: number = Date.now()): ProviderHealthSnapshot {
  return { lidarr: health(state.lidarr, at), musicbrainz: health(state.musicbrainz, at) };
}

/** Test seam — the counters are process-global, so a suite must be able to zero them. */
export function resetProviderHealth(): void {
  state.lidarr = emptyState();
  state.musicbrainz = emptyState();
}

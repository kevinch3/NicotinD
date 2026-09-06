import { beforeEach, describe, expect, it } from 'bun:test';
import {
  PROVIDER_HEALTH_WINDOW_MS,
  providerHealthSnapshot,
  recordProviderCall,
  resetProviderHealth,
} from './provider-health.js';

const T0 = 1_800_000_000_000;

beforeEach(() => resetProviderHealth());

describe('provider health counters (#670)', () => {
  it('reads as healthy-and-idle before any call', () => {
    const snap = providerHealthSnapshot(T0);
    expect(snap.lidarr).toMatchObject({ ok: 0, failed: 0, timedOut: 0, successRate: 1 });
    expect(snap.lidarr.lastFailureAt).toBeNull();
    expect(snap.musicbrainz.windowMs).toBe(PROVIDER_HEALTH_WINDOW_MS);
  });

  it('keeps the two providers apart', () => {
    recordProviderCall('lidarr', { ok: false, kind: 'http', status: 503 }, T0);
    recordProviderCall('musicbrainz', { ok: true }, T0);
    const snap = providerHealthSnapshot(T0);
    expect(snap.lidarr).toMatchObject({ ok: 0, failed: 1 });
    expect(snap.musicbrainz).toMatchObject({ ok: 1, failed: 0 });
  });

  it('rolls the rate up across buckets and counts timeouts as a subset of failures', () => {
    for (let i = 0; i < 6; i++) recordProviderCall('lidarr', { ok: true }, T0);
    recordProviderCall('lidarr', { ok: false, kind: 'timeout' }, T0 + 60_000);
    recordProviderCall('lidarr', { ok: false, kind: 'http', status: 500 }, T0 + 120_000);

    const snap = providerHealthSnapshot(T0 + 120_000);
    expect(snap.lidarr.ok).toBe(6);
    expect(snap.lidarr.failed).toBe(2);
    expect(snap.lidarr.timedOut).toBe(1);
    expect(snap.lidarr.successRate).toBeCloseTo(0.75, 10);
  });

  it('carries the last failure class and status, and leaves them alone on success', () => {
    recordProviderCall('musicbrainz', { ok: false, kind: 'http', status: 503 }, T0);
    recordProviderCall('musicbrainz', { ok: true }, T0 + 1000);

    const snap = providerHealthSnapshot(T0 + 1000);
    expect(snap.musicbrainz.lastFailureAt).toBe(T0);
    expect(snap.musicbrainz.lastFailureKind).toBe('http');
    expect(snap.musicbrainz.lastFailureStatus).toBe(503);
  });

  it('a timeout has no status — the request never got one', () => {
    recordProviderCall('lidarr', { ok: false, kind: 'timeout' }, T0);
    expect(providerHealthSnapshot(T0).lidarr.lastFailureStatus).toBeNull();
  });

  it('drops counts older than the window while keeping the last failure', () => {
    recordProviderCall('lidarr', { ok: false, kind: 'network' }, T0);
    const later = T0 + PROVIDER_HEALTH_WINDOW_MS;

    const snap = providerHealthSnapshot(later);
    expect(snap.lidarr).toMatchObject({ ok: 0, failed: 0, successRate: 1 });
    // The window bounds the *rate*; "when did it last break" is a different
    // question and outlives it.
    expect(snap.lidarr.lastFailureAt).toBe(T0);
  });

  it('stays bounded: a full window of traffic never grows past one ring', () => {
    // Two full windows of calls, one per second — an unbounded event list would
    // hold 1800 entries; the ring holds 15 buckets and reports only the window.
    for (let i = 0; i < 1800; i++) recordProviderCall('lidarr', { ok: true }, T0 + i * 1000);
    const end = T0 + 1799 * 1000;
    expect(providerHealthSnapshot(end).lidarr.ok).toBeLessThanOrEqual(
      PROVIDER_HEALTH_WINDOW_MS / 1000,
    );
  });
});

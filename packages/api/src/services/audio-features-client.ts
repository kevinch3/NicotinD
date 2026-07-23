import { createLogger } from '@nicotind/core';
import { MOOD_VOCAB } from './audio-tags.js';

const log = createLogger('audio-features-client');

/**
 * Thin HTTP client for the analysis sidecar (packages/analysis). Follows the
 * house pattern: raw fetch with an injectable fetchFn for tests, an
 * AbortSignal timeout per call, and a short-TTL cached health probe so the
 * windowed processor's availability checks don't hammer the sidecar.
 */

export interface AudioFeaturesResult {
  features: {
    danceability: number;
    valence: number;
    acousticness: number;
    instrumental: number;
    mood: string;
  };
  embedding: { model: string; dim: number; values: number[] };
  modelVersions: Record<string, string>;
  /** Discogs-genre inference riding the same /analyze call (issue #187 task
   *  A2) — an audio-inferred fallback, strictly below tag/MusicBrainz genre.
   *  `null` when absent (sidecar build predates the head) or malformed;
   *  parsed independently of `features` so a genre-parsing issue can never
   *  fail the whole payload. */
  genre: { label: string; style: string | null; confidence: number } | null;
}

/**
 * Thrown by {@link AudioFeaturesClient.analyze} when the sidecar returns HTTP
 * 422 — i.e. it *reached* the file and tried to decode it, but the bytes are
 * unusable (ffmpeg "Invalid data" / "decoded audio too short"). This is a
 * per-file condition (the file itself is bad), so the windowed processor ledgers
 * it so the file eventually drops out of the pending set — mirroring the
 * corrupt-file handling of the bpm/key/energy ffmpeg tasks.
 *
 * A 404 (file not found from the sidecar's perspective — usually a MUSIC_DIR
 * mount mismatch that 404s *every* file) and a 503 (models not loaded) stay as
 * `null`: those are environmental outages, and permanently skipping on them
 * would wrongly exclude the whole library even after the sidecar is fixed.
 */
export class AudioFileRejectedError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AudioFileRejectedError';
  }
}

/** Tempo result from the sidecar's RhythmExtractor2013 (`POST /rhythm`).
 *  `confidence` is Essentia's 0–5.32 scale (0 = none reported, ≥3.5 excellent). */
export interface RhythmResult {
  bpm: number;
  confidence: number;
}

const HEALTH_TTL_MS = 30_000;
const HEALTH_TIMEOUT_MS = 5_000;
// Analysis is ~seconds per track on CPU; leave generous headroom for cold caches.
const ANALYZE_TIMEOUT_MS = 120_000;

function clamp01(n: unknown): number | null {
  const v = typeof n === 'number' ? n : NaN;
  if (!Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

export class AudioFeaturesClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly healthTtlMs: number;
  private lastHealthAt = 0;
  private lastHealthy = false;
  private healthProbe: Promise<boolean> | null = null;

  constructor(opts: { baseUrl: string; fetchFn?: typeof fetch; healthTtlMs?: number }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchFn = opts.fetchFn ?? fetch;
    this.healthTtlMs = opts.healthTtlMs ?? HEALTH_TTL_MS;
  }

  /**
   * Synchronous last-known health for the (sync) task-availability hook. When
   * the cached value is stale a background refresh is kicked off — the first
   * call after a quiet period may report the previous state, converging on
   * the next scheduler tick.
   */
  healthySnapshot(): boolean {
    if (Date.now() - this.lastHealthAt >= this.healthTtlMs) void this.healthy();
    return this.lastHealthy;
  }

  /** Cached health probe: true only when the sidecar reports models loaded.
   *  Concurrent callers share one in-flight probe. */
  async healthy(): Promise<boolean> {
    if (this.healthProbe) return this.healthProbe;
    if (Date.now() - this.lastHealthAt < this.healthTtlMs) return this.lastHealthy;
    this.healthProbe = this.probeHealth().finally(() => {
      this.healthProbe = null;
    });
    return this.healthProbe;
  }

  private async probeHealth(): Promise<boolean> {
    let healthy = false;
    try {
      const res = await this.fetchFn(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        healthy = body.status === 'ok';
      }
    } catch {
      healthy = false;
    }
    this.lastHealthy = healthy;
    this.lastHealthAt = Date.now();
    return healthy;
  }

  /**
   * Analyze one track by library-relative path. Returns null on any failure
   * (unreachable sidecar, missing file, per-file inference failure) — callers
   * treat null as "skip, stays pending".
   */
  async analyze(relPath: string): Promise<AudioFeaturesResult | null> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath }),
        signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
      });
    } catch (err) {
      log.warn({ err, relPath }, 'analyze request failed');
      this.lastHealthy = false;
      this.lastHealthAt = Date.now();
      return null;
    }
    if (!res.ok) {
      // 422 = the sidecar reached + tried to decode the file but the bytes are
      // unusable (corrupt / too short). That's a per-file condition — throw so
      // the processor ledgers it (mirrors bpm/key/energy corrupt-file handling).
      // 404 (file not found from the sidecar — usually a mount mismatch that
      // 404s *every* file) and 503 (models not loaded) stay null: environmental
      // outages must NOT be ledgered or a misconfig would exclude the library.
      if (res.status === 422) {
        let detail = 'analysis sidecar rejected file';
        try {
          const body = (await res.json()) as { detail?: string };
          if (body.detail) detail = body.detail;
        } catch {
          /* keep the generic message */
        }
        throw new AudioFileRejectedError(detail, 422);
      }
      if (res.status === 503) {
        this.lastHealthy = false;
        this.lastHealthAt = Date.now();
      }
      log.warn({ relPath, status: res.status }, 'analyze returned non-OK');
      return null;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    return this.validate(body, relPath);
  }

  /**
   * Detect one track's tempo via the sidecar (`POST /rhythm`, Essentia
   * RhythmExtractor2013 — no TF models involved). Returns null on environmental
   * failures (unreachable, 503, 404 mount mismatch) so callers fall back to the
   * local music-tempo analyzer; throws {@link AudioFileRejectedError} on 422
   * (un-decodable file) so the processor ledgers it, mirroring analyze().
   */
  async rhythm(relPath: string): Promise<RhythmResult | null> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/rhythm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath }),
        signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
      });
    } catch (err) {
      log.warn({ err, relPath }, 'rhythm request failed');
      return null;
    }
    if (!res.ok) {
      if (res.status === 422) {
        let detail = 'analysis sidecar rejected file';
        try {
          const body = (await res.json()) as { detail?: string };
          if (body.detail) detail = body.detail;
        } catch {
          /* keep the generic message */
        }
        throw new AudioFileRejectedError(detail, 422);
      }
      log.warn({ relPath, status: res.status }, 'rhythm returned non-OK');
      return null;
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    const b = body as { bpm?: unknown; confidence?: unknown };
    const bpm = typeof b?.bpm === 'number' && Number.isFinite(b.bpm) && b.bpm > 0 ? b.bpm : null;
    if (bpm === null) {
      log.warn({ relPath }, 'rhythm payload failed validation');
      return null;
    }
    const confidence =
      typeof b.confidence === 'number' && Number.isFinite(b.confidence) ? b.confidence : 0;
    return { bpm, confidence };
  }

  /** Genre is a bonus field (see AudioFeaturesResult.genre) — anything
   *  missing/malformed simply resolves to null, never rejects the payload. */
  private validateGenre(body: unknown): AudioFeaturesResult['genre'] {
    const b = body as { genre?: { genre?: unknown; style?: unknown; confidence?: unknown } | null };
    const g = b?.genre;
    if (!g || typeof g.genre !== 'string' || g.genre.length === 0) return null;
    const confidence = clamp01(g.confidence);
    if (confidence === null) return null;
    return { label: g.genre, style: typeof g.style === 'string' ? g.style : null, confidence };
  }

  /** Validate + clamp the sidecar payload; null when structurally unusable. */
  private validate(body: unknown, relPath: string): AudioFeaturesResult | null {
    const b = body as {
      features?: Record<string, unknown>;
      embedding?: { model?: unknown; dim?: unknown; values?: unknown };
      modelVersions?: Record<string, string>;
    };
    const f = b?.features;
    const e = b?.embedding;
    const danceability = clamp01(f?.danceability);
    const valence = clamp01(f?.valence);
    const acousticness = clamp01(f?.acousticness);
    const instrumental = clamp01(f?.instrumental);
    const mood =
      typeof f?.mood === 'string' && (MOOD_VOCAB as readonly string[]).includes(f.mood)
        ? f.mood
        : null;
    const values = Array.isArray(e?.values) ? (e.values as unknown[]) : null;
    if (
      danceability === null ||
      valence === null ||
      acousticness === null ||
      instrumental === null ||
      mood === null ||
      typeof e?.model !== 'string' ||
      typeof e?.dim !== 'number' ||
      !values ||
      values.length !== e.dim ||
      !values.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      log.warn({ relPath }, 'analyze payload failed validation');
      return null;
    }
    return {
      features: { danceability, valence, acousticness, instrumental, mood },
      embedding: { model: e.model, dim: e.dim, values: values as number[] },
      modelVersions: b.modelVersions ?? {},
      genre: this.validateGenre(body),
    };
  }
}

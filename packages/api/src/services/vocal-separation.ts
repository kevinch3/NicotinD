/**
 * On-demand vocal separation for karaoke (issue #603): the API-side job runner
 * between the web's prepare/status endpoint and the GPU sidecar.
 *
 * One separation at a time — the GPU is one resource and the sidecar
 * serialises anyway — so this is a FIFO with one running job, an in-memory
 * status per track, and an ETA from the measured real-time factor. State is
 * in memory on purpose (the `MaintenanceService` argument): a restart loses
 * nothing durable, the cache on disk is the durable part, and a track that was
 * mid-separation simply gets asked for again.
 *
 * Failures are remembered by kind, mirroring `transcode-failures.ts`:
 *   - rejected (sidecar 422, or the FLAC failed the duration check): a verdict
 *     on the file, sticky until its identity (path+size+mtime) changes;
 *   - transient (503, timeout, transport): a verdict on the moment, kept for
 *     `STEM_TRANSIENT_FAILURE_TTL_MS` so a dead sidecar is not re-hit on every
 *     2 s poll, then retried.
 */
import { createLogger } from '@nicotind/core';
import { SeparationRejectedError, type SeparatorClient } from './separator-client.js';
import {
  StemOutputRejectedError,
  produceStem,
  readyStemPath,
  type ProduceStemOptions,
  type StemProducer,
} from './stem-store.js';
import { ffmpegAvailable as defaultFfmpegAvailable } from './transcode.js';
import { transcodeFailureKey } from './transcode-failures.js';

const log = createLogger('vocal-separation');

/** Measured on kpc (Quadro P4000, fp32, 21.77 s chunks): 5.68 s per chunk.
 *  Re-measure with the 2 s crossfade — docs/vocal-separation.md "Measured". */
export const SEPARATION_RTF = 0.261;
/** Worker respawn + checkpoint load after an idle release: measured 3–5 s on kpc
 *  (a 59 s track took 22.2 s cold vs ~17 s of inference). */
export const SEPARATION_COLD_START_SEC = 5;
/** Beyond this many queued tracks the sidecar's plate is full: `busy`. */
export const STEM_QUEUE_MAX = 8;
export const STEM_TRANSIENT_FAILURE_TTL_MS = 60_000;

/** ~3× the measured RTF plus a cold-start allowance, floored and capped. */
export function separateTimeoutMs(durationSec: number): number {
  return Math.min(
    900_000,
    Math.max(120_000, Math.round(durationSec * SEPARATION_RTF * 3 * 1000 + 60_000)),
  );
}

export function estimateEtaSec(args: {
  running: { durationSec: number; startedAt: number } | null;
  thisIsRunning: boolean;
  thisDurationSec: number;
  aheadDurations: number[];
  now: number;
  rtf?: number;
  coldStartSec?: number;
}): number {
  const rtf = args.rtf ?? SEPARATION_RTF;
  const coldStart = args.coldStartSec ?? SEPARATION_COLD_START_SEC;
  const remainingOf = (job: { durationSec: number; startedAt: number }) =>
    Math.max(0, job.durationSec * rtf - (args.now - job.startedAt) / 1000);
  let eta: number;
  if (args.thisIsRunning && args.running) {
    eta = remainingOf(args.running);
  } else {
    eta = args.running ? remainingOf(args.running) : coldStart;
    for (const d of args.aheadDurations) eta += d * rtf;
    eta += args.thisDurationSec * rtf;
  }
  return Math.max(1, Math.ceil(eta));
}

export type StemUnavailableReason =
  'not-configured' | 'disabled' | 'no-ffmpeg' | 'unhealthy' | 'busy';

export type StemStatus =
  | { state: 'idle' }
  | { state: 'unavailable'; reason: StemUnavailableReason }
  | { state: 'queued'; queuePosition: number; etaSec: number }
  | { state: 'preparing'; etaSec: number }
  | { state: 'ready' }
  | { state: 'failed'; reason: 'rejected' | 'transient'; retryAfterSec?: number };

interface Job {
  abs: string;
  relPath: string;
  durationSec: number;
  startedAt: number | null;
}

export interface VocalSeparationDeps {
  /** null = NICOTIND_SEPARATOR_URL unset. */
  client:
    | (Pick<SeparatorClient, 'healthy' | 'healthySnapshot'> &
        Partial<Pick<SeparatorClient, 'separate'>>)
    | null;
  toggle: { enabled(): boolean };
  stemCacheDir: string;
  ffmpegAvailable?: () => boolean;
  /** Test seam; defaults to `client.separate`. */
  producer?: StemProducer;
  validate?: ProduceStemOptions['validate'];
  now?: () => number;
}

export class VocalSeparationService {
  private readonly queue: Job[] = [];
  private running: Job | null = null;
  private readonly failures = new Map<
    string,
    { reason: 'rejected' | 'transient'; expiresAt: number | null }
  >();
  private readonly now: () => number;
  private readonly ffmpeg: () => boolean;
  private readonly producer: StemProducer;

  constructor(private readonly deps: VocalSeparationDeps) {
    this.now = deps.now ?? Date.now;
    this.ffmpeg = deps.ffmpegAvailable ?? defaultFfmpegAvailable;
    this.producer =
      deps.producer ??
      ((relPath, opts) => {
        const client = deps.client;
        if (!client?.separate) throw new Error('separator client not configured');
        return client.separate(relPath, opts);
      });
  }

  /** Structural gate, sync: nothing here can change between two polls. */
  configuredReason(): Exclude<StemUnavailableReason, 'unhealthy' | 'busy'> | null {
    if (!this.deps.client) return 'not-configured';
    if (!this.deps.toggle.enabled()) return 'disabled';
    // Also warms transcode.ts's ffmpeg probe, which the stem duration check reads.
    if (!this.ffmpeg()) return 'no-ffmpeg';
    return null;
  }

  /** The stream route's hook: a usable stem FLAC, or null. Never waits. */
  readyStemPath(abs: string): string | null {
    return readyStemPath(this.deps.stemCacheDir, abs);
  }

  /** Current status without side effects — the GET half of the endpoint. */
  status(abs: string, durationSec: number): StemStatus {
    if (this.readyStemPath(abs)) return { state: 'ready' };
    const job = this.findJob(abs);
    if (job) return this.jobStatus(job, durationSec);
    const failed = this.rememberedFailure(abs);
    if (failed) return failed;
    return { state: 'idle' };
  }

  /** Idempotent "make sure this stem exists": enqueue if needed, return the status. */
  async ensure(abs: string, relPath: string, durationSec: number): Promise<StemStatus> {
    if (this.readyStemPath(abs)) return { state: 'ready' };
    const job = this.findJob(abs);
    if (job) return this.jobStatus(job, durationSec);
    const structural = this.configuredReason();
    if (structural) return { state: 'unavailable', reason: structural };
    const failed = this.rememberedFailure(abs);
    if (failed) return failed;
    if (!(await this.deps.client!.healthy())) return { state: 'unavailable', reason: 'unhealthy' };
    if (this.queue.length >= STEM_QUEUE_MAX) return { state: 'unavailable', reason: 'busy' };

    const next: Job = { abs, relPath, durationSec, startedAt: null };
    this.queue.push(next);
    void this.drain();
    return this.jobStatus(next, durationSec);
  }

  private findJob(abs: string): Job | null {
    if (this.running?.abs === abs) return this.running;
    return this.queue.find((j) => j.abs === abs) ?? null;
  }

  private jobStatus(job: Job, durationSec: number): StemStatus {
    const now = this.now();
    const runningView =
      this.running && this.running.startedAt != null
        ? { durationSec: this.running.durationSec, startedAt: this.running.startedAt }
        : null;
    if (job === this.running) {
      return {
        state: 'preparing',
        etaSec: estimateEtaSec({
          running: runningView,
          thisIsRunning: true,
          thisDurationSec: durationSec,
          aheadDurations: [],
          now,
        }),
      };
    }
    const index = this.queue.indexOf(job);
    return {
      state: 'queued',
      queuePosition: index + 1,
      etaSec: estimateEtaSec({
        running: runningView,
        thisIsRunning: false,
        thisDurationSec: durationSec,
        aheadDurations: this.queue.slice(0, index).map((j) => j.durationSec),
        now,
      }),
    };
  }

  private failureKey(abs: string): string {
    return transcodeFailureKey(abs) ?? abs;
  }

  private rememberedFailure(abs: string): StemStatus | null {
    const key = this.failureKey(abs);
    const entry = this.failures.get(key);
    if (!entry) return null;
    if (entry.expiresAt != null && entry.expiresAt <= this.now()) {
      this.failures.delete(key);
      return null;
    }
    if (entry.reason === 'rejected') return { state: 'failed', reason: 'rejected' };
    return {
      state: 'failed',
      reason: 'transient',
      retryAfterSec: Math.max(1, Math.ceil(((entry.expiresAt ?? this.now()) - this.now()) / 1000)),
    };
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = job;
    job.startedAt = this.now();
    try {
      await produceStem(this.deps.stemCacheDir, job.abs, job.relPath, {
        producer: this.producer,
        timeoutMs: separateTimeoutMs(job.durationSec),
        validate: this.deps.validate,
      });
      log.info({ relPath: job.relPath, ms: this.now() - job.startedAt }, 'stem ready');
    } catch (err) {
      const rejected =
        err instanceof SeparationRejectedError || err instanceof StemOutputRejectedError;
      this.failures.set(this.failureKey(job.abs), {
        reason: rejected ? 'rejected' : 'transient',
        expiresAt: rejected ? null : this.now() + STEM_TRANSIENT_FAILURE_TTL_MS,
      });
      log.warn({ err, relPath: job.relPath, rejected }, 'separation failed');
    } finally {
      this.running = null;
    }
    void this.drain();
  }

  /** Test-only. */
  _resetForTests(): void {
    this.queue.length = 0;
    this.running = null;
    this.failures.clear();
  }
}

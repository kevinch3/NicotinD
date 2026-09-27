import { EventEmitter } from 'node:events';
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import type { Lidarr } from '../lidarr/index.js';
import { provisionArtist, sameProvisionTarget, type ProvisionTarget } from './lidarr-provision.js';
import { upsertDiscographyLink } from './discography.service.js';

const log = createLogger('artist-provisioning');

export type ProvisioningPhase = 'idle' | 'running' | 'cancelling';
export type ProvisioningOutcome = 'completed' | 'cancelled' | 'failed';
export type ProvisioningStartResult = 'started' | 'busy';

export interface ArtistProvisioningStatus {
  phase: ProvisioningPhase;
  target: ProvisionTarget | null;
  /** The Lidarr artist id once known (added, or found already monitored). */
  lidarrId: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastOutcome: ProvisioningOutcome | null;
  lastError: string | null;
  startedBy: string | null;
}

function idleStatus(): ArtistProvisioningStatus {
  return {
    phase: 'idle',
    target: null,
    lidarrId: null,
    startedAt: null,
    finishedAt: null,
    lastOutcome: null,
    lastError: null,
    startedBy: null,
  };
}

/**
 * Adds an artist to Lidarr as a background job (issue #644), in
 * `MaintenanceService`'s vocabulary: `getStatus`/`start`/`cancel`/`stop` and an
 * idle → running → cancelling phase machine, status in memory for the same
 * reasons. One add at a time — each is a whole-discography import on Lidarr's side.
 * See docs/album-hunt.md "Adding an artist to Lidarr is a job".
 */
export class ArtistProvisioningService extends EventEmitter {
  private busy = false;
  private stopRequested = false;
  private status: ArtistProvisioningStatus = idleStatus();
  private readonly now: () => Date;

  constructor(
    private readonly deps: { lidarr: Lidarr; db: Database; musicDir?: string },
    opts: { now?: () => Date } = {},
  ) {
    super();
    this.now = opts.now ?? (() => new Date());
  }

  getStatus(): ArtistProvisioningStatus {
    return { ...this.status, target: this.status.target ? { ...this.status.target } : null };
  }

  isRunningFor(target: ProvisionTarget): boolean {
    return this.busy && !!this.status.target && sameProvisionTarget(this.status.target, target);
  }

  /**
   * Fire-and-forget; answers synchronously so the route can reply 202/409. A
   * second start for the artist already being added is that same job, not busy.
   */
  start(target: ProvisionTarget, startedBy?: string | null): ProvisioningStartResult {
    if (this.busy) return this.isRunningFor(target) ? 'started' : 'busy';
    this.busy = true;
    this.stopRequested = false;
    this.status = {
      ...idleStatus(),
      phase: 'running',
      target: { ...target },
      startedAt: this.now().toISOString(),
      startedBy: startedBy ?? null,
    };
    this.emitStatus();
    void this.run(target);
    return 'started';
  }

  /** Stops the job before its add. An add already sent to Lidarr still lands. */
  cancel(): boolean {
    if (!this.busy) return false;
    this.stopRequested = true;
    this.status = { ...this.status, phase: 'cancelling' };
    this.emitStatus();
    return true;
  }

  /** Shutdown hook — same as cancel, named for the lifecycle call site. */
  stop(): void {
    this.stopRequested = true;
  }

  private async run(target: ProvisionTarget): Promise<void> {
    let outcome: ProvisioningOutcome = 'completed';
    try {
      const result = await provisionArtist(this.deps.lidarr, target, {
        musicDir: this.deps.musicDir,
        shouldStop: () => this.stopRequested,
      });
      if (!result) {
        outcome = 'cancelled';
      } else {
        const { artist } = result;
        if (target.localArtistId) {
          upsertDiscographyLink(
            this.deps.db,
            target.localArtistId,
            artist.id,
            artist.foreignArtistId,
          );
        }
        this.status = { ...this.status, lidarrId: artist.id };
      }
    } catch (err) {
      outcome = 'failed';
      this.status = { ...this.status, lastError: err instanceof Error ? err.message : String(err) };
      log.warn({ err, artist: target.artistName }, 'Artist provisioning failed');
    } finally {
      this.busy = false;
      this.stopRequested = false;
      this.status = {
        ...this.status,
        phase: 'idle',
        finishedAt: this.now().toISOString(),
        lastOutcome: outcome,
      };
      this.emitStatus();
      log.info({ artist: target.artistName, outcome }, 'Artist provisioning finished');
    }
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus());
  }
}

/** The shared 202/409 answer for a route that needs an artist Lidarr lacks. */
export function provisioningResponse(
  svc: ArtistProvisioningService,
  target: ProvisionTarget,
  startedBy?: string | null,
): { status: 202 | 409; body: Record<string, unknown> } {
  const outcome = svc.start(target, startedBy);
  if (outcome === 'busy') {
    return {
      status: 409,
      body: {
        error: 'Another artist is being added to Lidarr',
        code: 'PROVISIONING_BUSY',
        status: svc.getStatus(),
      },
    };
  }
  return {
    status: 202,
    body: { provisioning: true, code: 'ARTIST_PROVISIONING', status: svc.getStatus() },
  };
}

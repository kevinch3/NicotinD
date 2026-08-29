import { Injectable, inject, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DownloadsApiService } from './api/downloads-api.service';
import { SystemApiService } from './api/system-api.service';
import { LibraryApiService } from './api/library-api.service';
import type { AcquireJob, AcquisitionJobView } from '@nicotind/core';
import type { TransferEntry } from '../lib/transfer-types';
import { detectNewCompletion } from '../lib/transfer-utils';
import { createVisibilityPoller, type VisibilityPoller } from '../lib/visibility-poller';

export type { TransferEntry } from '../lib/transfer-types';

/**
 * Stages that keep the fast 3 s poll cadence (#806). Not just `downloading`:
 * the moment a cancel or completion moved a job to organizing/scanning the
 * poll used to drop to 30 s — exactly when the user is watching for the
 * change. `processing` stays on the slow tier on purpose: behind the review
 * hold it can honestly last hours (docs/web-ui.md cadence table).
 */
const FAST_POLL_STAGES: ReadonlySet<string> = new Set([
  'resolving',
  'queued',
  'downloading',
  'organizing',
  'scanning',
]);

/** Whether one network job keeps the poller on the fast cadence. Exported pure
 *  so the cadence rule is unit-testable without the service. */
export function jobKeepsFastCadence(job: AcquisitionJobView): boolean {
  return job.kind !== 'url' && job.state === 'active' && FAST_POLL_STAGES.has(job.stage);
}

/** Map a feed item status onto the transfer-state vocabulary the result cards
 *  key their lifecycle on (the raw slskd states, kept for compatibility). */
function itemStatusToTransferState(status: string): string {
  switch (status) {
    case 'done':
      return 'Completed, Succeeded';
    case 'failed':
    case 'unavailable':
    // 'skipped' is terminal too (DB 'unavailable': fallback exhausted / cancelled
    // — the track will never land), so it must not read as in-flight.
    case 'skipped':
      return 'Completed, Errored';
    case 'pending':
      return 'Queued, Remotely';
    default:
      return 'InProgress';
  }
}

@Injectable({ providedIn: 'root' })
export class TransferService {
  private api = inject(DownloadsApiService);
  private systemApi = inject(SystemApiService);
  private libraryApi = inject(LibraryApiService);

  readonly transfers = signal(new Map<string, TransferEntry>());
  readonly acquireJobs = signal<AcquireJob[]>([]);
  /** Unified acquisition jobs (all methods) — post-download stage source for the feed. */
  readonly acquisitionJobs = signal<AcquisitionJobView[]>([]);
  readonly libraryDirty = signal(false);
  readonly deletedSongIds = signal<ReadonlySet<string>>(new Set());
  /** Albums a curator just approved AND confirmed landed (issue #708) — narrower
   *  than `libraryDirty` on purpose: it only ever holds ids a caller can point
   *  to, so a listener can react without guessing what changed or resetting
   *  state for events unrelated to what the viewer is looking at. */
  readonly newlyLandedAlbumIds = signal<ReadonlySet<string>>(new Set());

  // Count of in-flight network jobs (unified feed). Shared by the header
  // indicator and the mobile bottom-nav badge so they never drift.
  readonly activeDownloadCount = computed(
    () =>
      this.acquisitionJobs().filter((j) => j.kind !== 'url' && j.stage === 'downloading').length,
  );

  // Paused while the tab is hidden (#717) — this poller feeds only derived
  // state (header badge, nav count, the libraryDirty flag), all of which the
  // catch-up poll on resume recomputes.
  private poller: VisibilityPoller = createVisibilityPoller({
    poll: () => this.poll(),
    delayMs: () => (this.hasActive ? 3_000 : 30_000),
  });
  private scanPollTimer: ReturnType<typeof setTimeout> | null = null;
  private prevAcquireStates = new Map<string, AcquireJob['state']>();
  private hasPolled = false;

  clearLibraryDirty(): void {
    this.libraryDirty.set(false);
  }

  // Flag the library as changed AND drop cached whole-library reads (artists /
  // genres), so the refresh that the dirty flag triggers actually re-fetches
  // instead of replaying a now-stale cached list. Public: the download-review
  // inbox (issue #411) calls this directly after an approve/discard, since
  // those mutate the library outside the poller's own completion detection.
  markLibraryDirty(): void {
    this.libraryDirty.set(true);
    this.libraryApi.invalidateLibraryReads();
  }

  addDeletedIds(ids: string[]): void {
    this.deletedSongIds.update((s) => {
      const next = new Set(s);
      for (const id of ids) next.add(id);
      return next;
    });
    this.startScanPoll();
  }

  clearDeletedIds(): void {
    this.deletedSongIds.set(new Set());
  }

  /** Record album ids a curator just approved AND confirmed landed. Call only
   *  with confirmed `landed: true` responses — never speculatively. */
  noteAlbumsLanded(ids: string[]): void {
    if (ids.length === 0) return;
    this.newlyLandedAlbumIds.update((s) => new Set([...s, ...ids]));
  }

  /** Consumed by the Library page once the viewer acts on the "new album
   *  added" banner (an explicit click, never an automatic reaction). */
  clearNewlyLandedAlbumIds(): void {
    this.newlyLandedAlbumIds.set(new Set());
  }

  private startScanPoll(): void {
    if (this.scanPollTimer !== null) return;
    this.scanPollTimer = setTimeout(() => this.doPollScan(0, false), 1000);
  }

  private async doPollScan(attempts: number, seenScanning: boolean): Promise<void> {
    this.scanPollTimer = null;
    if (attempts >= 20) {
      this.clearDeletedIds();
      this.markLibraryDirty();
      return;
    }
    try {
      const { scanning } = await firstValueFrom(this.systemApi.getScanStatus());
      if (scanning) {
        this.scanPollTimer = setTimeout(() => this.doPollScan(attempts + 1, true), 1500);
      } else if (!seenScanning && attempts < 5) {
        this.scanPollTimer = setTimeout(() => this.doPollScan(attempts + 1, false), 1000);
      } else {
        this.clearDeletedIds();
        this.markLibraryDirty();
      }
    } catch {
      this.clearDeletedIds();
    }
  }

  async poll(): Promise<void> {
    try {
      const jobs = await firstValueFrom(this.api.getAcquisitionJobs());
      // The per-item transfer map the search result cards key their lifecycle
      // on — sourced from the unified feed since the raw transfers lane's
      // removal (phase 3).
      const map = new Map<string, TransferEntry>();
      for (const job of jobs) {
        for (const item of job.items) {
          if (!item.username || !item.filename) continue;
          map.set(`${item.username}:${item.filename}`, {
            state: itemStatusToTransferState(item.status),
            percent: undefined,
          });
        }
      }
      const prevTransfers = this.transfers();
      const newCompletion = this.hasPolled && detectNewCompletion(prevTransfers, map);
      this.transfers.set(map);
      this.acquisitionJobs.set(jobs);
      this.hasPolled = true;
      if (newCompletion) this.markLibraryDirty();
    } catch {
      // non-fatal: keep stale data on network error
    }
    try {
      const jobs = await firstValueFrom(this.api.getAcquireJobs());
      // Detect running → done transitions to trigger a library refresh.
      let acquireCompletion = false;
      for (const job of jobs) {
        const prev = this.prevAcquireStates.get(job.id);
        if (prev === 'running' && job.state === 'done') {
          acquireCompletion = true;
        }
      }
      this.prevAcquireStates = new Map(jobs.map((j) => [j.id, j.state]));
      this.acquireJobs.set(jobs);
      if (acquireCompletion) this.markLibraryDirty();
    } catch {
      // non-fatal
    }
  }

  private get hasActive(): boolean {
    if (this.acquisitionJobs().some(jobKeepsFastCadence)) return true;
    return this.acquireJobs().some((j) => j.state === 'queued' || j.state === 'running');
  }

  startPolling(): void {
    this.poller.start();
  }

  stopPolling(): void {
    this.poller.stop();
  }

  reset(): void {
    this.stopPolling();
    if (this.scanPollTimer !== null) {
      clearTimeout(this.scanPollTimer);
      this.scanPollTimer = null;
    }
    this.transfers.set(new Map());
    this.acquisitionJobs.set([]);
    this.acquireJobs.set([]);
    this.libraryDirty.set(false);
    this.deletedSongIds.set(new Set());
    this.prevAcquireStates = new Map();
    this.hasPolled = false;
  }

  /** Immediately fires a poll and resets the adaptive timer. Call after
   *  initiating a download; resolves when the poll round-trip completes
   *  (pull-to-refresh awaits it so the spinner reflects real work). */
  kickPoll(): Promise<void> {
    return this.poller.kick();
  }

  getStatus(username: string, filename: string): TransferEntry | undefined {
    return this.transfers().get(`${username}:${filename}`);
  }
}

import { Injectable, inject, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import type { SlskdUserTransferGroup, AcquireJob } from '@nicotind/core';
import type { TransferEntry } from '../lib/transfer-types';
import { detectNewCompletion } from '../lib/transfer-utils';

export type { TransferEntry } from '../lib/transfer-types';

// Transfer file states that count as "in flight" for the active-download badge.
const ACTIVE_STATES = new Set(['InProgress', 'Queued', 'Initializing']);

@Injectable({ providedIn: 'root' })
export class TransferService {
  private api = inject(ApiService);

  readonly transfers = signal(new Map<string, TransferEntry>());
  readonly downloads = signal<SlskdUserTransferGroup[]>([]);
  readonly uploads = signal<SlskdUserTransferGroup[]>([]);
  readonly acquireJobs = signal<AcquireJob[]>([]);
  readonly libraryDirty = signal(false);
  readonly deletedSongIds = signal<ReadonlySet<string>>(new Set());

  // Count of download folders with at least one in-flight file. Shared by the
  // header indicator and the mobile bottom-nav badge so they never drift.
  readonly activeDownloadCount = computed(() =>
    this.downloads().reduce(
      (count, group) =>
        count +
        group.directories.filter((dir) => dir.files.some((f) => ACTIVE_STATES.has(f.state))).length,
      0,
    ),
  );

  private timerId: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private scanPollTimer: ReturnType<typeof setTimeout> | null = null;
  private prevAcquireStates = new Map<string, AcquireJob['state']>();
  private hasPolled = false;

  clearLibraryDirty(): void {
    this.libraryDirty.set(false);
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

  private startScanPoll(): void {
    if (this.scanPollTimer !== null) return;
    this.scanPollTimer = setTimeout(() => this.doPollScan(0, false), 1000);
  }

  private async doPollScan(attempts: number, seenScanning: boolean): Promise<void> {
    this.scanPollTimer = null;
    if (attempts >= 20) {
      this.clearDeletedIds();
      this.libraryDirty.set(true);
      return;
    }
    try {
      const { scanning } = await firstValueFrom(this.api.getScanStatus());
      if (scanning) {
        this.scanPollTimer = setTimeout(() => this.doPollScan(attempts + 1, true), 1500);
      } else if (!seenScanning && attempts < 5) {
        this.scanPollTimer = setTimeout(() => this.doPollScan(attempts + 1, false), 1000);
      } else {
        this.clearDeletedIds();
        this.libraryDirty.set(true);
      }
    } catch {
      this.clearDeletedIds();
    }
  }

  async poll(): Promise<void> {
    try {
      const data = await firstValueFrom(this.api.getDownloads());
      const map = new Map<string, TransferEntry>();
      for (const group of data) {
        for (const dir of group.directories) {
          for (const file of dir.files) {
            map.set(`${group.username}:${file.filename}`, {
              state: file.state,
              percent: file.percentComplete,
            });
          }
        }
      }
      const prevTransfers = this.transfers();
      const newCompletion = this.hasPolled && detectNewCompletion(prevTransfers, map);
      this.transfers.set(map);
      this.downloads.set(data);
      this.hasPolled = true;
      if (newCompletion) this.libraryDirty.set(true);
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
      if (acquireCompletion) this.libraryDirty.set(true);
    } catch {
      // non-fatal
    }
  }

  private get hasActive(): boolean {
    if (this.activeDownloadCount() > 0) return true;
    return this.acquireJobs().some((j) => j.state === 'queued' || j.state === 'running');
  }

  private scheduleNext(): void {
    this.timerId = setTimeout(() => this.tick(), this.hasActive ? 3_000 : 30_000);
  }

  private async tick(): Promise<void> {
    this.timerId = null;
    await this.poll();
    if (this.running) this.scheduleNext();
  }

  startPolling(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stopPolling(): void {
    this.running = false;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  /** Immediately fires a poll and resets the adaptive timer. Call after initiating a download. */
  kickPoll(): void {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    void this.tick();
  }

  getStatus(username: string, filename: string): TransferEntry | undefined {
    return this.transfers().get(`${username}:${filename}`);
  }
}

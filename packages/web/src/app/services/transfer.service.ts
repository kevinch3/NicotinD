import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import type { SlskdUserTransferGroup } from '@nicotind/core';
import type { TransferEntry } from '../lib/transfer-types';
import { detectNewCompletion } from '../lib/transfer-utils';

export type { TransferEntry } from '../lib/transfer-types';

@Injectable({ providedIn: 'root' })
export class TransferService {
  private api = inject(ApiService);

  readonly transfers = signal(new Map<string, TransferEntry>());
  readonly downloads = signal<SlskdUserTransferGroup[]>([]);
  readonly uploads = signal<SlskdUserTransferGroup[]>([]);
  readonly libraryDirty = signal(false);
  readonly deletedSongIds = signal<ReadonlySet<string>>(new Set());

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private scanPollTimer: ReturnType<typeof setTimeout> | null = null;

  clearLibraryDirty(): void {
    this.libraryDirty.set(false);
  }

  addDeletedIds(ids: string[]): void {
    this.deletedSongIds.update(s => {
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
      const newCompletion = detectNewCompletion(prevTransfers, map);
      this.transfers.set(map);
      this.downloads.set(data);
      if (newCompletion) this.libraryDirty.set(true);
    } catch {
      // non-fatal: keep stale data on network error
    }
    try {
      const uploadData = await firstValueFrom(this.api.getUploads());
      this.uploads.set(uploadData);
    } catch {
      // non-fatal
    }
  }

  startPolling(): void {
    if (this.intervalId) return;
    this.poll();
    this.intervalId = setInterval(() => this.poll(), 3000);
  }

  stopPolling(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getStatus(username: string, filename: string): TransferEntry | undefined {
    return this.transfers().get(`${username}:${filename}`);
  }
}

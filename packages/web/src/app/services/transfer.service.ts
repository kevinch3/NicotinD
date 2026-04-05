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
  readonly libraryDirty = signal(false);

  private intervalId: ReturnType<typeof setInterval> | null = null;

  clearLibraryDirty(): void {
    this.libraryDirty.set(false);
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

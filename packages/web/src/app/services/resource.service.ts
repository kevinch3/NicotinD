import { Injectable, inject, signal } from '@angular/core';
import { DownloadsApiService } from './api/downloads-api.service';
import { TransferService } from './transfer.service';
import { ToastService, type ToastAction } from './toast.service';
import { TranslateService } from './translate.service';
import type { AlternateSource, AlternateSourcesResult } from './api/api-types';
import { autoResourcePick } from '../lib/resource-auto-pick';

/** Long enough to read a peer, a coverage and a format; the Get countdown names less. */
export const RESOURCE_COUNTDOWN_SECONDS = 5;

/** The picker's inputs. `seed` is a search already run, so opening it costs no second hunt. */
export interface ResourcePickerTarget {
  jobId: string;
  titles: string[];
  seed: AlternateSourcesResult | null;
}

/**
 * "Complete from another peer", automatic by default: search, then switch to the
 * best peer behind a countdown that offers the picker. Root-provided because the
 * search outlives the card (the feed rebuilds every row on each poll) and the
 * page (the countdown is a toast).
 *
 * → docs/download-pipeline.md "Automatic by default, a picker on request"
 */
@Injectable({ providedIn: 'root' })
export class ResourceService {
  private api = inject(DownloadsApiService);
  private transfer = inject(TransferService);
  private toasts = inject(ToastService);
  private i18n = inject(TranslateService);

  /** Cards with a re-source under way: searching, counting down, or in the picker. */
  private readonly held = signal<ReadonlySet<string>>(new Set());
  readonly picker = signal<ResourcePickerTarget | null>(null);

  isBusy(jobId: string | null | undefined): boolean {
    return !!jobId && this.held().has(jobId);
  }

  start(jobId: string, titles: string[]): void {
    if (this.isBusy(jobId)) return;
    this.hold(jobId, true);
    this.api.searchAlternateSources(jobId, titles).subscribe({
      next: (res) => this.offer(jobId, titles, res),
      error: () => {
        this.hold(jobId, false);
        this.report('downloads.resource.searchFailed');
      },
    });
  }

  closePicker(): void {
    const open = this.picker();
    if (!open) return;
    this.picker.set(null);
    this.hold(open.jobId, false);
  }

  /** The picker started a re-source itself. */
  async picked(result: { peer: string; count: number }): Promise<void> {
    const open = this.picker();
    this.picker.set(null);
    await this.announce(result.peer, result.count);
    if (open) this.hold(open.jobId, false);
  }

  private offer(jobId: string, titles: string[], res: AlternateSourcesResult): void {
    if (!res.alternates.length) {
      this.hold(jobId, false);
      // Offline is "we could not look", never "nobody has it" (#1040).
      this.report(res.sourceOffline ? 'downloads.resource.offline' : 'downloads.resource.none');
      return;
    }
    const pick = autoResourcePick(res);
    if (!pick) return this.openPicker(jobId, titles, res);

    let id!: string;
    id = this.toasts.show({
      message: this.i18n.t('downloads.resource.auto', {
        peer: pick.username,
        covered: pick.coveredTitles.length,
        wanted: res.wanted.length,
        format: pick.format,
        seconds: RESOURCE_COUNTDOWN_SECONDS,
      }),
      kind: 'info',
      countdown: RESOURCE_COUNTDOWN_SECONDS,
      actions: [
        {
          label: this.i18n.t('downloads.resource.useNow'),
          callback: () => {
            this.toasts.dismiss(id);
            this.switchTo(jobId, titles, pick);
          },
        },
        {
          label: this.i18n.t('downloads.resource.cancel'),
          callback: () => {
            this.toasts.dismiss(id);
            this.hold(jobId, false);
          },
        },
        {
          label: this.i18n.t('downloads.resource.choose'),
          callback: () => {
            this.toasts.dismiss(id);
            this.openPicker(jobId, titles, res);
          },
        },
      ],
    });
    // At the toast cap a countdown is dropped unseen and never fires, so the
    // choice would be nobody's: hand it to the picker.
    if (!this.toasts.toasts().some((t) => t.id === id)) this.openPicker(jobId, titles, res);
  }

  private switchTo(jobId: string, titles: string[], pick: AlternateSource): void {
    this.api.resourceJob(jobId, pick.candidateRef, pick.coveredTitles).subscribe({
      next: (res) => {
        void this.announce(pick.username, res.resourced).then(() => this.hold(jobId, false));
      },
      error: (err: { status?: number }) => {
        this.hold(jobId, false);
        // 409 is the source still holding the album; another search fixes nothing (#1069).
        if (err?.status === 409) return this.report('downloads.resource.conflict');
        this.report('downloads.resource.failed', {
          label: this.i18n.t('downloads.resource.choose'),
          callback: () => this.openPicker(jobId, titles, null),
        });
      },
    });
  }

  private openPicker(jobId: string, titles: string[], seed: AlternateSourcesResult | null): void {
    this.hold(jobId, true);
    this.picker.set({ jobId, titles, seed });
  }

  private async announce(peer: string, count: number): Promise<void> {
    this.toasts.show({
      message: this.i18n.t('downloads.resource.started', { count, peer }),
      kind: 'success',
    });
    // The new addon job's items only reach the card on the poller's next tick.
    await this.transfer.kickPoll();
  }

  /** An error that stays until dismissed: at 4 s a failure read as silence (#1543). */
  private report(key: string, next?: ToastAction): void {
    let id!: string;
    const dismiss: ToastAction = {
      label: this.i18n.t('downloads.dismiss'),
      callback: () => this.toasts.dismiss(id),
    };
    id = this.toasts.show({
      message: this.i18n.t(key),
      kind: 'error',
      actions: next
        ? [
            dismiss,
            {
              label: next.label,
              callback: () => {
                this.toasts.dismiss(id);
                next.callback();
              },
            },
          ]
        : [dismiss],
    });
  }

  private hold(jobId: string, on: boolean): void {
    this.held.update((s) => {
      if (s.has(jobId) === on) return s;
      const next = new Set(s);
      if (on) next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  }
}

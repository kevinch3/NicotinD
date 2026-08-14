import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ImportService } from '../../../services/import.service';
import { ConfirmService } from '../../../services/confirm.service';
import { TranslateService } from '../../../services/translate.service';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { httpErrorMessage } from '../../../lib/http-error';
import { formatBytes } from '../../../lib/disk-usage';
import { isElectron } from '../../../lib/platform';
import { pickDirectory } from '../../../services/native/native-capabilities';
import type { ImportJob, ImportPreview } from '../../../../types/core';

/**
 * Admin "Import music" card (docs/import.md): point NicotinD at a server-side
 * folder and run it through the same organize → scan → quarantine pipeline a
 * download takes. Lives on the Admin page (not /get) because import is
 * admin-only and must work on streaming-only installs where the Downloads
 * page is hard-404'd. Polls its jobs only while the card is open AND an
 * import is in flight — an idle Admin page makes no import requests.
 */
@Component({
  selector: 'app-import-card',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  templateUrl: './import-card.component.html',
})
export class ImportCardComponent implements OnDestroy {
  private importApi = inject(ImportService);
  private confirm = inject(ConfirmService);
  private i18n = inject(TranslateService);

  path = '';
  removeOriginals = false;

  readonly isElectron = isElectron;
  readonly preview = signal<ImportPreview | null>(null);
  readonly previewLoading = signal(false);
  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);
  readonly jobs = signal<ImportJob[]>([]);
  readonly loaded = signal(false);

  readonly activeJob = computed(
    () => this.jobs().find((j) => j.state === 'queued' || j.state === 'running') ?? null,
  );
  readonly finishedJobs = computed(() =>
    this.jobs().filter((j) => j.state !== 'queued' && j.state !== 'running'),
  );

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  ngOnDestroy(): void {
    this.stopPoll();
  }

  /** Fetch once per expand (the group re-emits `opened` on every expand). */
  load(): void {
    if (this.loaded()) return;
    this.loaded.set(true);
    this.refreshJobs();
  }

  formatBytes(bytes: number): string {
    return formatBytes(bytes);
  }

  progressPct(job: ImportJob): number {
    if (job.filesTotal <= 0) return 0;
    return Math.min(100, Math.round((job.filesDone / job.filesTotal) * 100));
  }

  async browse(): Promise<void> {
    const picked = await pickDirectory();
    if (picked) {
      this.path = picked;
      this.preview.set(null);
    }
  }

  runPreview(): void {
    const path = this.path.trim();
    if (!path || this.previewLoading()) return;
    this.previewLoading.set(true);
    this.error.set(null);
    this.importApi.preview(path).subscribe({
      next: (p) => {
        this.preview.set(p);
        this.previewLoading.set(false);
      },
      error: (err) => {
        this.preview.set(null);
        this.previewLoading.set(false);
        this.error.set(httpErrorMessage(err, this.i18n.t('admin.musicImportPreviewFailed')));
      },
    });
  }

  async start(): Promise<void> {
    const path = this.path.trim();
    if (!path || this.submitting()) return;
    if (this.removeOriginals) {
      const ok = await this.confirm.ask(this.i18n.t('admin.musicImportMoveConfirm'));
      if (!ok) return;
    }
    this.submitting.set(true);
    this.error.set(null);
    this.importApi.submit(path, this.removeOriginals).subscribe({
      next: () => {
        this.submitting.set(false);
        this.preview.set(null);
        this.refreshJobs();
      },
      error: (err) => {
        this.submitting.set(false);
        this.error.set(httpErrorMessage(err, this.i18n.t('admin.musicImportStartFailed')));
      },
    });
  }

  cancel(job: ImportJob): void {
    this.importApi.cancel(job.id).subscribe({ next: () => this.refreshJobs() });
  }

  retry(job: ImportJob): void {
    this.error.set(null);
    this.importApi.retry(job.id).subscribe({
      next: () => this.refreshJobs(),
      error: (err) =>
        this.error.set(httpErrorMessage(err, this.i18n.t('admin.musicImportStartFailed'))),
    });
  }

  remove(job: ImportJob): void {
    this.importApi.delete(job.id).subscribe({ next: () => this.refreshJobs() });
  }

  private refreshJobs(): void {
    this.importApi.jobs().subscribe({
      next: ({ jobs }) => {
        this.jobs.set(jobs);
        // Poll only while something is actually moving.
        if (jobs.some((j) => j.state === 'queued' || j.state === 'running')) this.startPoll();
        else this.stopPoll();
      },
      error: () => this.stopPoll(),
    });
  }

  private startPoll(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.refreshJobs(), 3000);
  }

  private stopPoll(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}

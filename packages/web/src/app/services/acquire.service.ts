import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ToastService } from './toast.service';

export type AcquireBackend = 'ytdlp' | 'spotdl';

export interface AcquireJob {
  id: string;
  backend: AcquireBackend;
  url: string;
  label: string | null;
  state: 'queued' | 'running' | 'done' | 'failed';
  progress: { done: number; total: number } | null;
  error: string | null;
  created_at: number;
}

@Injectable({ providedIn: 'root' })
export class AcquireService {
  private http = inject(HttpClient);
  private toasts = inject(ToastService);

  readonly jobs = signal<AcquireJob[]>([]);
  readonly activeJobs = computed(() =>
    this.jobs().filter((j) => j.state === 'queued' || j.state === 'running'),
  );
  readonly hasActive = computed(() => this.activeJobs().length > 0);

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private completedJobIds = new Set<string>();
  // Guard so the first refresh baselines all existing terminal jobs silently
  // (no toast). Matches TransferService.hasPolled.
  private hasRefreshed = false;

  async submit(url: string, backend?: AcquireBackend): Promise<string> {
    const res = await firstValueFrom(
      this.http.post<{ jobId: string }>('/api/acquire', { url, backend }),
    );
    void this.refresh();
    this.ensurePolling();
    return res.jobId;
  }

  async cancel(jobId: string): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/acquire/jobs/${jobId}`));
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const jobs = await firstValueFrom(this.http.get<AcquireJob[]>('/api/acquire/jobs'));
      for (const job of jobs) {
        if ((job.state === 'done' || job.state === 'failed') && !this.completedJobIds.has(job.id)) {
          this.completedJobIds.add(job.id);
          // Only toast if this job transitioned after the first refresh — on
          // the initial load we silently baseline to avoid replaying stale
          // completions/failures from before the user opened the app.
          if (this.hasRefreshed) {
            // A 'done' job can still carry an `error`: a partial-download
            // warning (e.g. spotdl only matching some tracks) rides in the same
            // field as a hard failure so this can't read as an unqualified
            // success when it wasn't one.
            this.toasts.show(
              job.state === 'failed'
                ? { message: job.error ?? 'Download failed.', kind: 'error' }
                : job.error
                  ? { message: job.error, kind: 'error' }
                  : { message: 'Your track has been added to the library.', kind: 'success' },
            );
          }
        }
      }
      this.jobs.set(jobs);
      if (this.activeJobs().length === 0) {
        this.stopPolling();
      }
    } catch {
      // Non-fatal; stale UI is acceptable
    }
    this.hasRefreshed = true;
  }

  private ensurePolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.refresh(), 2_000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  reset(): void {
    this.stopPolling();
    this.jobs.set([]);
    this.completedJobIds.clear();
    this.hasRefreshed = false;
  }
}

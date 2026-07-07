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
        if (job.state === 'done' && !this.completedJobIds.has(job.id)) {
          this.completedJobIds.add(job.id);
          this.toasts.show({
            message: 'Your track has been added to the library.',
            kind: 'success',
          });
        }
      }
      this.jobs.set(jobs);
      if (this.activeJobs().length === 0) {
        this.stopPolling();
      }
    } catch {
      // Non-fatal; stale UI is acceptable
    }
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
  }
}

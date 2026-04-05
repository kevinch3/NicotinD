import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-download-indicator',
  template: `
    <button
      (click)="navigate()"
      class="relative p-1.5 text-zinc-400 hover:text-zinc-200 transition rounded-md hover:bg-zinc-800/50"
      [title]="activeCount() > 0 ? activeCount() + ' active downloads' : 'Downloads'"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      @if (activeCount() > 0) {
        <span class="absolute -top-1 -right-1 bg-blue-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
          {{ activeCount() }}
        </span>
      }
    </button>
  `,
})
export class DownloadIndicatorComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private router = inject(Router);

  readonly activeCount = signal(0);
  private intervalId: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.fetchDownloads();
    this.intervalId = setInterval(() => this.fetchDownloads(), 3000);
  }

  ngOnDestroy(): void {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  navigate(): void {
    this.router.navigate(['/downloads']);
  }

  private fetchDownloads(): void {
    this.api.getDownloads().subscribe({
      next: (data) => {
        let count = 0;
        for (const t of data as any[]) {
          for (const dir of t.directories ?? []) {
            const hasActive = (dir.files ?? []).some(
              (f: any) => f.state === 'InProgress' || f.state === 'Queued' || f.state === 'Initializing',
            );
            if (hasActive) count++;
          }
        }
        this.activeCount.set(count);
      },
      error: () => { /* ignore */ },
    });
  }
}

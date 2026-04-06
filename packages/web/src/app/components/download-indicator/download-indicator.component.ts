import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-download-indicator',
  templateUrl: './download-indicator.component.html',
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

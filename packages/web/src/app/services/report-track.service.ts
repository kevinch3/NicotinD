import { Injectable, inject, signal } from '@angular/core';
import { BackButtonService } from './native/back-button.service';

/**
 * Opens the report-a-track dialog from anywhere. A single ReportTrackHost
 * (mounted in the layout) renders `target()`; the Now Playing sheet's flag
 * button and every song-row `⋯` menu call `open()`.
 *
 * The dialog used to be mounted inside the Now Playing sheet off a local
 * signal, which is why nothing outside that sheet could reach it (issue
 * #1038). Root, mirroring `TrackInfoService`, so it is mounted once.
 */
@Injectable({ providedIn: 'root' })
export class ReportTrackService {
  private readonly backButton = inject(BackButtonService);
  private unregisterBack: (() => void) | null = null;

  readonly target = signal<string | null>(null);

  open(trackId: string): void {
    this.target.set(trackId);
    // Hardware Back closes the dialog first (issue #394) — pushed per-open so
    // it sits above the persistent Now Playing handler.
    this.unregisterBack ??= this.backButton.stack.push(() => {
      this.close();
      return true;
    });
  }

  close(): void {
    this.target.set(null);
    this.unregisterBack?.();
    this.unregisterBack = null;
  }
}

import { Injectable, inject, signal } from '@angular/core';
import { BackButtonService } from './native/back-button.service';

export interface TrackInfoTarget {
  songId: string;
  title?: string;
  artist?: string;
  album?: string;
  coverArt?: string | null;
}

/**
 * Opens the track-info sheet from anywhere. A single TrackInfoHost (mounted in
 * the layout) renders `target()`; the now-playing view and every song-row menu
 * call `open()`. Root so the sheet is mounted once, not per-consumer.
 */
@Injectable({ providedIn: 'root' })
export class TrackInfoService {
  private readonly backButton = inject(BackButtonService);
  private unregisterBack: (() => void) | null = null;

  readonly target = signal<TrackInfoTarget | null>(null);
  open(t: TrackInfoTarget): void {
    this.target.set(t);
    // Hardware Back closes the sheet first (issue #394) — pushed per-open so
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

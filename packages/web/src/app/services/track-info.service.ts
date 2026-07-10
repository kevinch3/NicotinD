import { Injectable, signal } from '@angular/core';

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
  readonly target = signal<TrackInfoTarget | null>(null);
  open(t: TrackInfoTarget): void {
    this.target.set(t);
  }
  close(): void {
    this.target.set(null);
  }
}

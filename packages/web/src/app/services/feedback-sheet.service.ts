import { Injectable, signal } from '@angular/core';
import type { FolderRef } from '../../types/core';

/** One folder candidate the human can pick as the actually-correct match. */
export interface FeedbackSheetCandidate extends FolderRef {
  matchPct: number;
  format: string;
}

export interface FeedbackSheetPayload {
  feedbackId: number;
  artistName: string;
  albumTitle: string;
  candidates: FeedbackSheetCandidate[];
}

/**
 * Opens the hunt-feedback "which folder was actually correct?" detail sheet from
 * anywhere (the capture toast's 👎 action). A single host (mounted in the layout)
 * renders `payload()`. Root so it's mounted once. See docs/generation-feedback.md.
 */
@Injectable({ providedIn: 'root' })
export class FeedbackSheetService {
  readonly payload = signal<FeedbackSheetPayload | null>(null);
  open(p: FeedbackSheetPayload): void {
    this.payload.set(p);
  }
  close(): void {
    this.payload.set(null);
  }
}

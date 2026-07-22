import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { GenerationVerdict, HuntMatchItemFlags } from '../../types/core';

/**
 * Client for the generation-feedback capture API. Grades a pending server-side
 * snapshot (the album-hunt recognition pair) via PATCH, and throttles the capture
 * toast to one prompt per hunt event so radio replenish / re-renders don't spam.
 * See docs/generation-feedback.md.
 */
@Injectable({ providedIn: 'root' })
export class FeedbackService {
  private http = inject(HttpClient);

  // Feedback ids already prompted this session — the base+skew merge, re-renders
  // and future radio replenish all re-surface the same id; only prompt once.
  private prompted = new Set<number>();

  resolve(
    id: number,
    verdict: GenerationVerdict,
    opts: { note?: string; itemFlags?: HuntMatchItemFlags } = {},
  ) {
    const body: { verdict: GenerationVerdict; note?: string; itemFlags?: HuntMatchItemFlags } = {
      verdict,
    };
    if (opts.note) body.note = opts.note;
    if (opts.itemFlags) body.itemFlags = opts.itemFlags;
    return this.http.patch<{ ok: boolean }>(`/api/feedback/${id}`, body);
  }

  /** True at most once per distinct feedbackId (and never for a falsy id). */
  shouldPrompt(feedbackId: number | undefined | null): boolean {
    if (!feedbackId) return false;
    if (this.prompted.has(feedbackId)) return false;
    this.prompted.add(feedbackId);
    return true;
  }
}

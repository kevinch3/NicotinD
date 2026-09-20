import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { CurationRound } from './api-types';

/** Curator triage (docs/curator-triage.md). Stateless, per-domain, like every
 *  other service under `services/api/` — there is no monolithic ApiService. */
@Injectable({ providedIn: 'root' })
export class CurationApiService {
  private readonly http = inject(HttpClient);

  getRound() {
    return this.http.get<CurationRound>('/api/library/curation/round');
  }

  getCount() {
    return this.http.get<{ open: number; awaitingAgent: number }>('/api/library/curation/count');
  }

  applyCase(caseId: string, optionId: string) {
    return this.http.post<{ ok: boolean; detail: string }>(
      `/api/library/curation/cases/${caseId}/apply`,
      { optionId },
    );
  }

  /** "Skip for now": a server-side deferral, so the card stays out of later rounds too. */
  skipCase(caseId: string) {
    return this.http.post<{ ok: boolean; until: number }>(
      `/api/library/curation/cases/${caseId}/skip`,
      {},
    );
  }
}

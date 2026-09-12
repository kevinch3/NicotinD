import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { CurationCase } from './api-types';

/** Curator triage (docs/curator-triage.md). Stateless, per-domain, like every
 *  other service under `services/api/` — there is no monolithic ApiService. */
@Injectable({ providedIn: 'root' })
export class CurationApiService {
  private readonly http = inject(HttpClient);

  getRound() {
    return this.http.get<{ cases: CurationCase[] }>('/api/library/curation/round');
  }

  getCount() {
    return this.http.get<{ open: number }>('/api/library/curation/count');
  }

  applyCase(caseId: string, optionId: string) {
    return this.http.post<{ ok: boolean; detail: string }>(
      `/api/library/curation/cases/${caseId}/apply`,
      { optionId },
    );
  }
}

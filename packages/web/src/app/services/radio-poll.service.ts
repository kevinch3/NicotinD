import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Observable } from 'rxjs';
import type { RadioPollResults, RadioPollSettings, RadioPollSummary } from '../../types/core';

export interface CreateRadioPollBody extends Partial<RadioPollSettings> {
  name: string;
  expiresInHours?: number;
}

/**
 * Thin authenticated wrapper for the admin half of radio evaluation polls
 * (docs/radio-eval-polls.md). The public wizard talks to /api/radio-polls
 * directly (no auth) and deliberately does not use this service.
 */
@Injectable({ providedIn: 'root' })
export class RadioPollService {
  private http = inject(HttpClient);

  create(body: CreateRadioPollBody): Observable<{ id: string; token: string; url: string }> {
    return this.http.post<{ id: string; token: string; url: string }>(
      '/api/admin/radio-polls',
      body,
    );
  }

  list(): Observable<RadioPollSummary[]> {
    return this.http.get<RadioPollSummary[]>('/api/admin/radio-polls');
  }

  results(id: string): Observable<RadioPollResults> {
    return this.http.get<RadioPollResults>(`/api/admin/radio-polls/${id}`);
  }

  close(id: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`/api/admin/radio-polls/${id}/close`, {});
  }

  remove(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/admin/radio-polls/${id}`);
  }
}

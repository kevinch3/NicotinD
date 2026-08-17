import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Observable } from 'rxjs';
import type { ImportJob, ImportJobDir, ImportPreview } from '../../types/core';

/**
 * Client for the admin folder-import API (docs/import.md). Stateless HTTP
 * wrapper — polling/UI state lives in ImportCardComponent, which is the only
 * consumer and polls just while an import is in flight.
 */
@Injectable({ providedIn: 'root' })
export class ImportService {
  private http = inject(HttpClient);

  preview(path: string): Observable<ImportPreview> {
    return this.http.post<ImportPreview>('/api/admin/import/preview', { path });
  }

  submit(path: string, removeOriginals: boolean): Observable<{ jobId: string }> {
    return this.http.post<{ jobId: string }>('/api/admin/import', { path, removeOriginals });
  }

  jobs(): Observable<{ jobs: ImportJob[] }> {
    return this.http.get<{ jobs: ImportJob[] }>('/api/admin/import/jobs');
  }

  job(id: string): Observable<{ job: ImportJob; dirs: ImportJobDir[] }> {
    return this.http.get<{ job: ImportJob; dirs: ImportJobDir[] }>(`/api/admin/import/jobs/${id}`);
  }

  cancel(id: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>(`/api/admin/import/jobs/${id}/cancel`, {});
  }

  retry(id: string): Observable<{ jobId: string }> {
    return this.http.post<{ jobId: string }>(`/api/admin/import/jobs/${id}/retry`, {});
  }

  delete(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/admin/import/jobs/${id}`);
  }
}

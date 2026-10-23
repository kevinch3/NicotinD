import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { SubsonicKeyMintResponse, SubsonicKeyRow } from './api-types';

/** OpenSubsonic API keys (docs/opensubsonic.md) — the credential a Subsonic
 *  app such as Music Assistant uses on `/rest`. Mirrors AgentTokensApiService. */
@Injectable({ providedIn: 'root' })
export class SubsonicKeysApiService {
  private http = inject(HttpClient);

  listKeys() {
    return this.http.get<{ keys: SubsonicKeyRow[] }>('/api/subsonic-keys');
  }

  /** The returned `key` is the raw secret — shown exactly once. */
  mintKey(name: string) {
    return this.http.post<SubsonicKeyMintResponse>('/api/subsonic-keys', { name });
  }

  revokeKey(id: string) {
    return this.http.delete<{ ok: boolean }>(`/api/subsonic-keys/${encodeURIComponent(id)}`);
  }
}

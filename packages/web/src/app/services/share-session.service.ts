import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type ShareResourceType = 'playlist' | 'album' | 'artist';

export interface ShareActivation {
  jwt: string;
  resourceType: ShareResourceType;
  resourceId: string;
}

export interface ShareResource {
  resourceType: ShareResourceType;
  resourceId: string;
}

@Injectable({ providedIn: 'root' })
export class ShareSessionService {
  private http = inject(HttpClient);

  readonly shareJwt = signal<string | null>(null);

  async activate(token: string): Promise<ShareActivation> {
    const result = await firstValueFrom(
      this.http.post<ShareActivation>(`/api/share/activate/${token}`, null),
    );
    this.shareJwt.set(result.jwt);
    return result;
  }

  /**
   * Map a share token → resource WITHOUT activating the public 5-minute window
   * (issue #230). Auth-gated server-side, so it's only usable by a logged-in
   * caller — the share-view uses it to deep-link an authenticated user into the
   * real in-app page under their own session instead of burning the token on the
   * restricted guest view. Never touches `shareJwt` (there's no public session).
   */
  async resolve(token: string): Promise<ShareResource> {
    return firstValueFrom(this.http.get<ShareResource>(`/api/share/${token}/resource`));
  }

  reset(): void {
    this.shareJwt.set(null);
  }
}

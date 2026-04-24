import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface ShareActivation {
  jwt: string;
  resourceType: 'playlist' | 'album';
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
}

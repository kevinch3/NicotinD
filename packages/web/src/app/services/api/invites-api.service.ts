import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type {
  CreateInviteRequest,
  InviteInspection,
  InviteLinkResponse,
  InviteSummary,
} from './api-types';

/**
 * Invitations (docs/email-invitations.md). The admin half lives under
 * `/api/admin/invites`; `inspect`/`accept` are the public landing page's,
 * called before any session exists. Tokens always travel in a POST body —
 * the link keeps them in the URL fragment so no server log ever sees one.
 */
@Injectable({ providedIn: 'root' })
export class InvitesApiService {
  private http = inject(HttpClient);

  list() {
    return this.http.get<{ invites: InviteSummary[] }>('/api/admin/invites');
  }

  create(body: CreateInviteRequest) {
    return this.http.post<InviteLinkResponse>('/api/admin/invites', body);
  }

  /** New link for a pending invite; the old link stops working. */
  rotateLink(id: string) {
    return this.http.post<InviteLinkResponse>(`/api/admin/invites/${id}/link`, {});
  }

  revoke(id: string) {
    return this.http.delete<{ invite: InviteSummary }>(`/api/admin/invites/${id}`);
  }

  inspect(token: string) {
    return this.http.post<InviteInspection>('/api/invites/inspect', { token });
  }

  accept(token: string, username: string, password: string) {
    return this.http.post<{ token: string; user: { id: string; username: string; role: string } }>(
      '/api/invites/accept',
      { token, username, password },
    );
  }
}

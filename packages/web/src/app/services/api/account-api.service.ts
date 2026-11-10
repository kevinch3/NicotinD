import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { KEEP_SESSION_ON_401 } from '../../lib/http-context';

/** What an admin-issued reset link mint returns (docs/email-invitations.md). */
export interface ResetLinkResponse {
  path: string;
  urls: string[];
  expiresAt: number;
}

export type ResetInspection =
  { status: 'valid'; username: string } | { status: 'invalid' | 'expired' | 'used' };

/**
 * Account security (docs/email-invitations.md, increment 2): the signed-in
 * user's own password change, an admin's reset link, and the public landing
 * page's inspect/complete. Reset tokens only ever travel in POST bodies.
 */
@Injectable({ providedIn: 'root' })
export class AccountApiService {
  private http = inject(HttpClient);

  /**
   * Returns a fresh token for this device — every other session ends. A wrong
   * current password is a 403, never a 401, so it cannot sign the user out.
   */
  changePassword(currentPassword: string, newPassword: string) {
    return this.http.put<{ token: string }>('/api/me/account/password', {
      currentPassword,
      newPassword,
    });
  }

  issueResetLink(userId: string) {
    return this.http.post<ResetLinkResponse>('/api/admin/password-resets', { userId });
  }

  inspectReset(token: string) {
    return this.http.post<ResetInspection>('/api/password-reset/inspect', { token });
  }

  /** Public page: a stale stored session must not bounce it to /login. */
  completeReset(token: string, password: string) {
    return this.http.post<{ token: string; user: { id: string; username: string; role: string } }>(
      '/api/password-reset/complete',
      { token, password },
      { context: new HttpContext().set(KEEP_SESSION_ON_401, true) },
    );
  }
}

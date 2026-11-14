import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { KEEP_SESSION_ON_401 } from '../../lib/http-context';
import type { MailSendResult } from './api-types';

/** What an admin-issued reset link mint returns (docs/email-invitations.md). */
export interface ResetLinkResponse {
  path: string;
  urls: string[];
  expiresAt: number;
}

/** `PUT /api/admin/password-resets { userId, send: true }` — the link is mailed, never returned. */
export interface EmailedResetResponse {
  mail: MailSendResult;
  expiresAt: number;
}

/** `GET /api/me/account` (increment 5). */
export interface AccountView {
  email: string | null;
  emailVerified: boolean;
  /** An address waiting for its verification link to be opened. */
  pendingEmail: string | null;
  /** Whether this server can send mail at all. */
  mailEnabled: boolean;
}

/** `PUT /api/me/account/email`: the view, plus how the verification mail went when one was sent. */
export type AccountEmailResult = AccountView & { mail?: MailSendResult };

/** `PUT /api/admin/user-emails/:id` — the user's address state after *Assign email…*. */
export interface AssignedEmailResult {
  email: string | null;
  emailVerified: boolean;
  pendingEmail: string | null;
  /** Present when a confirmation link was sent (or failed to be). */
  mail?: MailSendResult;
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

  /** *Email reset link*: the same 24 h link, mailed to the user's verified address. */
  emailResetLink(userId: string) {
    return this.http.post<EmailedResetResponse>('/api/admin/password-resets', {
      userId,
      send: true,
    });
  }

  /** *Assign email…*: a confirmation link to `email`; `''` removes the address. */
  assignUserEmail(userId: string, email: string) {
    return this.http.put<AssignedEmailResult>(
      `/api/admin/user-emails/${encodeURIComponent(userId)}`,
      { email },
    );
  }

  getAccount() {
    return this.http.get<AccountView>('/api/me/account');
  }

  /**
   * `''` clears the address; anything else mails a verification link and only
   * becomes the account's email once that link is opened. A wrong password is
   * a 403, never a 401.
   */
  changeEmail(email: string, currentPassword: string) {
    return this.http.put<AccountEmailResult>('/api/me/account/email', { email, currentPassword });
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

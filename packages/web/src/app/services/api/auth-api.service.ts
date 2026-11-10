import type { StrategyId, UserPreferences } from '@nicotind/core';
import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import type { AuthResult } from './api-types';
import { KEEP_SESSION_ON_401 } from '../../lib/http-context';

/** Public calls made from pages a stale stored session must not bounce to /login. */
const publicCall = () => ({ context: new HttpContext().set(KEEP_SESSION_ON_401, true) });

export interface UserProfile {
  id: string;
  username: string;
  role: string;
  welcomeDismissed: boolean;
  /** Stable per-user media credential (#1329); null for a share session, absent on older servers. */
  mediaKey?: string | null;
  /** The remembered variety position (docs/radio.md "Strategies"); older servers omit it. */
  radioStrategy?: StrategyId;
  /** Admin dev-mode: capture generated results as gradeable feedback. */
  /**
   * Deployment-wide acquisition kill-switch (#235). false = the whole
   * acquisition module is off for this install; the web hides every acquisition
   * surface regardless of role. Optional for back-compat with an older server
   * that predates the field (treated as enabled).
   */
  acquisitionEnabled?: boolean;
  /** Everything that follows the person across devices (#1299); older servers omit it. */
  preferences?: UserPreferences;
}

/** Auth endpoints: login, registration, and sliding-session refresh. */
@Injectable({ providedIn: 'root' })
export class AuthApiService {
  private http = inject(HttpClient);

  login(username: string, password: string) {
    return this.http.post<AuthResult>('/api/auth/login', { username, password });
  }

  register(username: string, password: string) {
    return this.http.post<AuthResult>('/api/auth/register', { username, password });
  }

  getRegistrationStatus() {
    return this.http.get<{ enabled: boolean }>('/api/auth/registration-status');
  }

  /** Whether "Forgot password?" is offered: the admin turned it on and mail is on. */
  getRecoveryStatus() {
    return this.http.get<{ enabled: boolean }>('/api/auth/recovery-status', publicCall());
  }

  /**
   * Always `{ ok: true }`, whether or not an account matched — the page shows
   * one confirmation for every input (docs/email-invitations.md, increment 5).
   */
  forgotPassword(identifier: string) {
    return this.http.post<{ ok: true }>('/api/auth/forgot', { identifier }, publicCall());
  }

  /** Opens an email verification link; 404/410/409 carry `code`. */
  verifyEmail(token: string) {
    return this.http.post<{ ok: true; email: string }>(
      '/api/auth/verify-email',
      { token },
      publicCall(),
    );
  }

  // Sliding session: exchange the current valid token for a fresh one.
  refreshToken(context?: HttpContext) {
    return this.http.post<{ token: string }>('/api/auth/refresh', {}, { context });
  }

  dismissWelcome() {
    return this.http.post<void>('/api/auth/dismiss-welcome', {});
  }

  getMe(context?: HttpContext) {
    return this.http.get<UserProfile>('/api/auth/me', { context });
  }
}

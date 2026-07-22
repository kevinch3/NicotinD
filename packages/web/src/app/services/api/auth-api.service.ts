import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { AuthResult } from './api-types';

export interface UserProfile {
  id: string;
  username: string;
  role: string;
  welcomeDismissed: boolean;
  autoplayOnLoad: boolean;
  /** Admin dev-mode: capture generated results as gradeable feedback. */
  feedbackCapture: boolean;
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

  // Sliding session: exchange the current valid token for a fresh one.
  refreshToken() {
    return this.http.post<{ token: string }>('/api/auth/refresh', {});
  }

  dismissWelcome() {
    return this.http.post<void>('/api/auth/dismiss-welcome', {});
  }

  setAutoplayOnLoad(enabled: boolean) {
    return this.http.post<{ ok: boolean }>('/api/auth/autoplay', { enabled });
  }

  setFeedbackCapture(enabled: boolean) {
    return this.http.post<{ ok: boolean }>('/api/auth/feedback-capture', { enabled });
  }

  getMe() {
    return this.http.get<UserProfile>('/api/auth/me');
  }
}

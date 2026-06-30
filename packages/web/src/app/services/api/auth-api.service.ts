import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { AuthResult } from './api-types';

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
}

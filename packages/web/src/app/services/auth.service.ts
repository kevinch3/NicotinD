import { Injectable, signal, computed } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly token = signal<string | null>(localStorage.getItem('nicotind_token'));
  readonly username = signal<string | null>(localStorage.getItem('nicotind_username'));
  readonly role = signal<string | null>(localStorage.getItem('nicotind_role') ?? 'user');
  readonly isAuthenticated = computed(() => !!this.token());

  login(token: string, username: string, role: string): void {
    localStorage.setItem('nicotind_token', token);
    localStorage.setItem('nicotind_username', username);
    localStorage.setItem('nicotind_role', role);
    this.token.set(token);
    this.username.set(username);
    this.role.set(role);
  }

  logout(): void {
    // Clear auth tokens
    localStorage.removeItem('nicotind_token');
    localStorage.removeItem('nicotind_username');
    localStorage.removeItem('nicotind_role');
    // Clear all user-scoped persisted state so the next user starts fresh.
    // Device-scoped prefs (theme, device id/name, remote-enabled, library-mode,
    // downloaded-folders cache) are intentionally left intact.
    localStorage.removeItem('nicotind_player_state');
    localStorage.removeItem('nicotind:search-history');
    this.token.set(null);
    this.username.set(null);
    this.role.set(null);
  }
}

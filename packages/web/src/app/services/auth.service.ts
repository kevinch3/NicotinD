import { Injectable, signal, computed } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly token = signal<string | null>(localStorage.getItem('nicotind_token'));
  readonly username = signal<string | null>(localStorage.getItem('nicotind_username'));
  readonly role = signal<string | null>(localStorage.getItem('nicotind_role') ?? 'user');
  readonly isAuthenticated = computed(() => !!this.token());
  readonly welcomeDismissed = signal<boolean>(false);

  login(token: string, username: string, role: string): void {
    localStorage.setItem('nicotind_token', token);
    localStorage.setItem('nicotind_username', username);
    localStorage.setItem('nicotind_role', role);
    this.token.set(token);
    this.username.set(username);
    this.role.set(role);
  }

  /**
   * Swap in a renewed access token (sliding session) without disturbing the
   * cached username/role. Used by the boot-time silent refresh.
   */
  setToken(token: string): void {
    localStorage.setItem('nicotind_token', token);
    this.token.set(token);
  }

  logout(): void {
    localStorage.removeItem('nicotind_token');
    localStorage.removeItem('nicotind_username');
    localStorage.removeItem('nicotind_role');
    localStorage.removeItem('nicotind_player_state');
    localStorage.removeItem('nicotind:search-history');
    this.token.set(null);
    this.username.set(null);
    this.role.set(null);
    this.welcomeDismissed.set(false);
  }
}

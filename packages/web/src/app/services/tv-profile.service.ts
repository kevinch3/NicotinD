import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { AuthApiService } from './api/auth-api.service';
import { forgetProfile, loadProfiles, rememberProfile, type TvProfile } from '../lib/tv-profiles';

/**
 * Profiles on a shared TV (#1406). One box, several people: the store keeps a
 * device JWT per person and the switch swaps which one is the ACTIVE session.
 *
 * Nothing else in the app knows about profiles. Every API call, socket, listen
 * and preference read already keys off `nicotind_token`; a switch is therefore
 * `resetSession()` (which drops every per-person cache and key — the queue,
 * the preferences mirror, likes, remote playback) followed by `login()` with
 * the stored token. Holding the remote is enough: the owner chose the Netflix
 * model over a PIN.
 */
@Injectable({ providedIn: 'root' })
export class TvProfileService {
  private readonly auth = inject(AuthService);
  private readonly api = inject(AuthApiService);
  private readonly router = inject(Router);

  private readonly people = signal<TvProfile[]>(loadProfiles(localStorage));
  readonly profiles = this.people.asReadonly();
  readonly active = this.auth.username;
  /** People whose stored token the server refused. PR 2's listeners fill it;
   *  a fresh login clears the name. */
  readonly stale = signal<ReadonlySet<string>>(new Set());

  constructor() {
    // Mirror the active session into the store. Runs on login AND on the
    // boot-time silent refresh (`setToken`), so a stored token is the newest
    // one this TV has seen for that person.
    effect(() => {
      const token = this.auth.token();
      const username = this.auth.username();
      const role = this.auth.role() ?? 'user';
      if (!token || !username) return;
      untracked(() => {
        this.people.set(rememberProfile(localStorage, { username, role, token }));
        if (this.stale().has(username)) {
          const next = new Set(this.stale());
          next.delete(username);
          this.stale.set(next);
        }
      });
    });
  }

  async switchTo(username: string): Promise<void> {
    const target = this.people().find((p) => p.username === username);
    if (!target) return;
    this.auth.resetSession();
    this.auth.login(target.token, target.username, target.role);
    try {
      // The sliding refresh, awaited here so an expired token is known now
      // rather than as a 401 on the first library call. Role from /me, as boot does.
      const { token } = await firstValueFrom(this.api.refreshToken());
      this.auth.setToken(token);
      const me = await firstValueFrom(this.api.getMe());
      this.auth.setRole(me.role);
      if (me.mediaKey !== undefined) this.auth.setMediaKey(me.mediaKey);
      this.auth.welcomeDismissed.set(me.welcomeDismissed);
      await this.router.navigate(['/']);
    } catch {
      this.auth.resetSession();
      this.people.set(forgetProfile(localStorage, username));
      await this.router.navigate(['/login']);
    }
  }

  /** Bring a new person in through the QR flow. The current person stays in
   *  the store, so abandoning the QR loses nothing. */
  beginAdd(): void {
    this.auth.resetSession();
    void this.router.navigate(['/login']);
  }

  /** Forget the active person on THIS TV (their token here, not their account)
   *  and hand the box to the next one, or to the QR when nobody is left. */
  async signOut(): Promise<void> {
    const leaving = this.auth.username();
    this.auth.logout();
    if (leaving) this.people.set(forgetProfile(localStorage, leaving));
    const next = this.people()[0];
    if (next) await this.switchTo(next.username);
    else await this.router.navigate(['/login']);
  }
}

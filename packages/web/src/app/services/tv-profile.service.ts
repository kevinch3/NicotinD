import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from './auth.service';
import { AuthApiService } from './api/auth-api.service';
import { PlayerService } from './player.service';
import { UserPreferencesService } from './user-preferences.service';
import { ThemeService } from './theme.service';
import { TranslateService } from './translate.service';
import { ServerConfigService } from './server-config.service';
import { refreshSession } from '../app.config';
import { isTvBuild } from '../lib/platform';
import { forgetProfile, loadProfiles, rememberProfile, type TvProfile } from '../lib/tv-profiles';

/**
 * Profiles on a shared TV (#1406). One box, several people: the store keeps a
 * device JWT per person and the switch swaps which one is the ACTIVE session.
 *
 * Nothing else in the app knows about profiles. Every API call, socket, listen
 * and preference read already keys off `nicotind_token`; a switch is therefore
 * `resetSession()` (which drops every per-person cache and key — the queue,
 * the preferences mirror, likes, remote playback) followed by `login()` with
 * the stored token and the same `refreshSession` a boot runs. Holding the
 * remote is enough: the owner chose the Netflix model over a PIN.
 *
 * TV build only: the service is root-provided and the login page injects it on
 * every build, so each side effect checks `isTvBuild()` — a phone or desktop
 * must never mirror its tokens into the store.
 */
@Injectable({ providedIn: 'root' })
export class TvProfileService {
  private readonly auth = inject(AuthService);
  private readonly api = inject(AuthApiService);
  private readonly router = inject(Router);
  private readonly player = inject(PlayerService);
  private readonly prefs = inject(UserPreferencesService);
  private readonly theme = inject(ThemeService);
  private readonly i18n = inject(TranslateService);
  private readonly serverConfig = inject(ServerConfigService);

  /** Bumped on every store write, so `profiles` re-reads. */
  private readonly revision = signal(0);
  /** The newest switch; an older one still awaiting stops at its next await. */
  private generation = 0;

  /** This server's people — the store is keyed per server, so "Switch server"
   *  never offers one server's JWT to another. */
  readonly profiles = computed<TvProfile[]>(() => {
    this.revision();
    this.serverConfig.baseUrl();
    return isTvBuild() ? loadProfiles(localStorage, this.server()) : [];
  });
  readonly active = this.auth.username;
  /** People whose stored token the server refused. PR 2's listeners fill it;
   *  a fresh login clears the name. */
  readonly stale = signal<ReadonlySet<string>>(new Set());

  constructor() {
    // Mirror the active session into the store. Runs on login AND on the
    // boot-time silent refresh (`setToken`), so a stored token is the newest
    // one this TV has seen for that person.
    effect(() => {
      if (!isTvBuild()) return;
      const token = this.auth.token();
      const username = this.auth.username();
      const role = this.auth.role() ?? 'user';
      if (!token || !username) return;
      untracked(() => {
        rememberProfile(localStorage, this.server(), { username, role, token });
        this.revision.update((n) => n + 1);
        if (this.stale().has(username)) {
          const next = new Set(this.stale());
          next.delete(username);
          this.stale.set(next);
        }
      });
    });
  }

  async switchTo(username: string, opts: { landing?: '/' | '/player' } = {}): Promise<void> {
    if (!isTvBuild()) return;
    const landing = opts.landing ?? '/';
    // The /who screen renders the active person as a pressable row too —
    // pressing it must not reset the session it is currently showing. Nor may
    // it touch the generation: a repeat press on the row being switched to
    // would cancel that switch's own refresh.
    if (username === this.auth.username()) {
      await this.router.navigate([landing]);
      return;
    }
    const gen = ++this.generation;
    const isStale = () => gen !== this.generation;
    const target = this.profiles().find((p) => p.username === username);
    if (!target) return;
    this.auth.resetSession();
    this.auth.login(target.token, target.username, target.role);

    // The boot refresh, awaited here so an expired token is known now rather
    // than as a 401 on the first library call, and so the person's radio
    // variety, theme and language follow them. Only a REFUSED refresh (401/403)
    // means the stored token is dead: forget the person and go back to the
    // people, or to the QR when nobody is left. Any other failure (offline,
    // 5xx, a `/me` hiccup) keeps the login and goes Home like a clean switch.
    const result = await refreshSession(
      this.api,
      this.auth,
      this.player,
      { prefs: this.prefs, theme: this.theme, i18n: this.i18n },
      { isStale },
    );
    if (isStale()) return;
    if (result === 'refused') {
      this.auth.resetSession();
      this.forget(username);
      await this.router.navigate(this.profiles().length ? ['/who'] : ['/login']);
      return;
    }
    await this.router.navigate([landing]);
  }

  /** A person whose stored token a listener's socket had refused (#1406). */
  markStale(username: string): void {
    this.stale.set(new Set([...this.stale(), username]));
  }

  /** Bring a new person in through the QR flow. The current person stays in
   *  the store, so abandoning the QR loses nothing. */
  beginAdd(): void {
    if (!isTvBuild()) return;
    this.auth.resetSession();
    void this.router.navigate(['/login']);
  }

  /** Forget the active person on THIS TV (their token here, not their account)
   *  and hand the box to the next one, or to the QR when nobody is left. */
  async signOut(): Promise<void> {
    if (!isTvBuild()) return;
    const leaving = this.auth.username();
    this.auth.logout();
    if (leaving) this.forget(leaving);
    const next = this.profiles()[0];
    if (next) await this.switchTo(next.username);
    else await this.router.navigate(['/login']);
  }

  /** The saved server URL, read at each call like `AuthService.logout` does. */
  private server(): string {
    return localStorage.getItem('nicotind_server_url') ?? '';
  }

  private forget(username: string): void {
    forgetProfile(localStorage, this.server(), username);
    this.revision.update((n) => n + 1);
  }
}

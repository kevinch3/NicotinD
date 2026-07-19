import { Injectable, signal, computed, inject, Injector } from '@angular/core';
import { PlayerService } from './player.service';
import { SearchService } from './search.service';
import { TransferService } from './transfer.service';
import { AcquireService } from './acquire.service';
import { PlaylistService } from './playlist.service';
import { WatchlistService } from './watchlist.service';
import { RemotePlaybackService } from './remote-playback.service';
import { ShareSessionService } from './share-session.service';
import { AutoHuntService } from './auto-hunt.service';
import { ToastService } from './toast.service';
import { ListControlsService } from './list-controls.service';
import { LibraryApiService } from './api/library-api.service';
import { AuthApiService } from './api/auth-api.service';
import {
  asRole,
  canAcquire as canAcquireRole,
  canCurate as canCurateRole,
  isAdmin as isAdminRole,
} from '../../types/core';
import { clearStashedSession } from '../lib/server-registry';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private injector = inject(Injector);
  private player = inject(PlayerService);
  private search = inject(SearchService);
  private transfers = inject(TransferService);
  private acquire = inject(AcquireService);
  private playlists = inject(PlaylistService);
  private watchlist = inject(WatchlistService);
  private shareSession = inject(ShareSessionService);
  private autoHunt = inject(AutoHuntService);
  private toasts = inject(ToastService);
  private listControls = inject(ListControlsService);
  private libraryApi = inject(LibraryApiService);
  private authApi = inject(AuthApiService);

  readonly token = signal<string | null>(localStorage.getItem('nicotind_token'));
  readonly username = signal<string | null>(localStorage.getItem('nicotind_username'));
  readonly role = signal<string | null>(localStorage.getItem('nicotind_role') ?? 'user');
  readonly isAuthenticated = computed(() => !!this.token());

  /** Capability computeds — the single source of truth for role-gated UI. Mirror
   * the server-side guards (requireAcquirer / requireCurator / requireAdmin). */
  readonly isAdmin = computed(() => isAdminRole(asRole(this.role())));
  /** Can use acquisition surfaces (Downloads, hunt, URL acquire, network search). */
  readonly canAcquire = computed(() => canAcquireRole(asRole(this.role())));
  /** Can curate the library (edit/merge/delete albums, metadata, identity). */
  readonly canCurate = computed(() => canCurateRole(asRole(this.role())));
  readonly welcomeDismissed = signal<boolean>(false);
  readonly autoplayOnLoad = signal<boolean>(false);

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

  /**
   * Update the cached role (signal + localStorage) from the authoritative server
   * profile on boot. The refresh re-reads role from the DB, so an admin's role
   * change takes effect on the user's next load — not only on a full re-login.
   */
  setRole(role: string): void {
    localStorage.setItem('nicotind_role', role);
    this.role.set(role);
  }

  /**
   * Persist the per-user "autoplay on page load" preference server-side and
   * mirror it in the local signal. Optimistic: the toggle reflects instantly
   * while the request is in flight; errors roll it back to the previous value.
   */
  setAutoplayOnLoad(enabled: boolean): void {
    const prev = this.autoplayOnLoad();
    this.autoplayOnLoad.set(enabled);
    this.authApi.setAutoplayOnLoad(enabled).subscribe({
      error: () => this.autoplayOnLoad.set(prev),
    });
  }

  /** Explicit sign-out: also forgets the per-server stashed session for the
   * current server — otherwise switching servers and back would silently
   * restore the session the user just ended. */
  logout(): void {
    clearStashedSession(localStorage, localStorage.getItem('nicotind_server_url') ?? '');
    this.resetSession();
  }

  /**
   * Clear the active session + all per-server client state (player queue,
   * search, transfers, caches…). Used by logout above and by the native
   * server-picker when switching servers — a switch must not leak the old
   * server's queue/covers/caches into the new one, but must keep the stashed
   * sessions that make switching back seamless.
   */
  resetSession(): void {
    this.player.clear();
    this.search.reset();
    this.transfers.reset();
    this.acquire.reset();
    this.playlists.reset();
    this.watchlist.reset();
    // Lazy resolve to break circular dependency (RemotePlaybackService injects AuthService)
    this.injector.get(RemotePlaybackService).reset();
    this.shareSession.reset();
    this.autoHunt.reset();
    this.toasts.reset();
    this.listControls.reset();
    this.libraryApi.invalidateLibraryReads();

    localStorage.removeItem('nicotind_token');
    localStorage.removeItem('nicotind_username');
    localStorage.removeItem('nicotind_role');
    localStorage.removeItem('nicotind_player_state');
    localStorage.removeItem('nicotind:search-history');
    localStorage.removeItem('nicotind:downloaded-folders');
    localStorage.removeItem('nicotind-library-state');
    localStorage.removeItem('nicotind-library-mode');
    localStorage.removeItem('nicotind-library-show-hidden');

    this.token.set(null);
    this.username.set(null);
    this.role.set(null);
    this.welcomeDismissed.set(false);
    this.autoplayOnLoad.set(false);
  }
}

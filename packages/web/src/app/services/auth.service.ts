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

  logout(): void {
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

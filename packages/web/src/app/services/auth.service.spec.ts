import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AuthService } from './auth.service';
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

describe('AuthService', () => {
  let auth: AuthService;
  let player: { clear: ReturnType<typeof vi.fn> };
  let search: { reset: ReturnType<typeof vi.fn> };
  let transfers: { reset: ReturnType<typeof vi.fn> };
  let acquire: { reset: ReturnType<typeof vi.fn> };
  let playlists: { reset: ReturnType<typeof vi.fn> };
  let watchlist: { reset: ReturnType<typeof vi.fn> };
  let remote: { reset: ReturnType<typeof vi.fn> };
  let shareSession: { reset: ReturnType<typeof vi.fn> };
  let autoHunt: { reset: ReturnType<typeof vi.fn> };
  let toasts: { reset: ReturnType<typeof vi.fn> };
  let listControls: { reset: ReturnType<typeof vi.fn> };
  let libraryApi: { invalidateLibraryReads: ReturnType<typeof vi.fn> };
  let authApi: { setAutoplayOnLoad: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    localStorage.clear();
    player = { clear: vi.fn() };
    search = { reset: vi.fn() };
    transfers = { reset: vi.fn() };
    acquire = { reset: vi.fn() };
    playlists = { reset: vi.fn() };
    watchlist = { reset: vi.fn() };
    remote = { reset: vi.fn() };
    shareSession = { reset: vi.fn() };
    autoHunt = { reset: vi.fn() };
    toasts = { reset: vi.fn() };
    listControls = { reset: vi.fn() };
    libraryApi = { invalidateLibraryReads: vi.fn() };
    authApi = { setAutoplayOnLoad: vi.fn().mockReturnValue({ subscribe: () => ({}) }) };

    TestBed.configureTestingModule({
      providers: [
        AuthService,
        { provide: PlayerService, useValue: player },
        { provide: SearchService, useValue: search },
        { provide: TransferService, useValue: transfers },
        { provide: AcquireService, useValue: acquire },
        { provide: PlaylistService, useValue: playlists },
        { provide: WatchlistService, useValue: watchlist },
        { provide: RemotePlaybackService, useValue: remote },
        { provide: ShareSessionService, useValue: shareSession },
        { provide: AutoHuntService, useValue: autoHunt },
        { provide: ToastService, useValue: toasts },
        { provide: ListControlsService, useValue: listControls },
        { provide: LibraryApiService, useValue: libraryApi },
        { provide: AuthApiService, useValue: authApi },
      ],
    });
    auth = TestBed.inject(AuthService);
  });

  describe('setToken (sliding-session renewal)', () => {
    it('updates the token signal and localStorage', () => {
      auth.setToken('fresh-token');

      expect(auth.token()).toBe('fresh-token');
      expect(localStorage.getItem('nicotind_token')).toBe('fresh-token');
    });

    it('leaves the cached username and role untouched', () => {
      localStorage.setItem('nicotind_token', 'old-token');
      localStorage.setItem('nicotind_username', 'alice');
      localStorage.setItem('nicotind_role', 'admin');
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          AuthService,
          { provide: PlayerService, useValue: player },
          { provide: SearchService, useValue: search },
          { provide: TransferService, useValue: transfers },
          { provide: AcquireService, useValue: acquire },
          { provide: PlaylistService, useValue: playlists },
          { provide: WatchlistService, useValue: watchlist },
          { provide: RemotePlaybackService, useValue: remote },
          { provide: ShareSessionService, useValue: shareSession },
          { provide: AutoHuntService, useValue: autoHunt },
          { provide: ToastService, useValue: toasts },
          { provide: ListControlsService, useValue: listControls },
          { provide: LibraryApiService, useValue: libraryApi },
          { provide: AuthApiService, useValue: authApi },
        ],
      });
      const freshAuth = TestBed.inject(AuthService);

      freshAuth.setToken('renewed-token');

      expect(freshAuth.username()).toBe('alice');
      expect(freshAuth.role()).toBe('admin');
      expect(localStorage.getItem('nicotind_username')).toBe('alice');
      expect(localStorage.getItem('nicotind_role')).toBe('admin');
      expect(freshAuth.isAuthenticated()).toBe(true);
    });
  });

  it('login then setToken keeps identity but swaps the token', () => {
    auth.login('t1', 'bob', 'user');
    auth.setToken('t2');

    expect(auth.token()).toBe('t2');
    expect(auth.username()).toBe('bob');
    expect(auth.role()).toBe('user');
  });

  describe('logout', () => {
    it('calls reset on all services and clears user-specific localStorage', () => {
      auth.login('token123', 'alice', 'admin');
      localStorage.setItem('nicotind:downloaded-folders', '["a","b"]');
      localStorage.setItem('nicotind-library-state', '{"type":"newest"}');
      localStorage.setItem('nicotind-library-mode', 'albums');
      localStorage.setItem('nicotind-library-show-hidden', '1');
      localStorage.setItem('nicotind-theme', '{"state":{}}');
      localStorage.setItem('nicotind_device_id', 'device-123');

      auth.logout();

      expect(player.clear).toHaveBeenCalled();
      expect(search.reset).toHaveBeenCalled();
      expect(transfers.reset).toHaveBeenCalled();
      expect(acquire.reset).toHaveBeenCalled();
      expect(playlists.reset).toHaveBeenCalled();
      expect(watchlist.reset).toHaveBeenCalled();
      expect(remote.reset).toHaveBeenCalled();
      expect(shareSession.reset).toHaveBeenCalled();
      expect(autoHunt.reset).toHaveBeenCalled();
      expect(toasts.reset).toHaveBeenCalled();
      expect(listControls.reset).toHaveBeenCalled();
      expect(libraryApi.invalidateLibraryReads).toHaveBeenCalled();

      expect(auth.token()).toBeNull();
      expect(auth.username()).toBeNull();
      expect(auth.role()).toBeNull();
      expect(auth.isAuthenticated()).toBe(false);

      expect(localStorage.getItem('nicotind_token')).toBeNull();
      expect(localStorage.getItem('nicotind_username')).toBeNull();
      expect(localStorage.getItem('nicotind_role')).toBeNull();
      expect(localStorage.getItem('nicotind_player_state')).toBeNull();
      expect(localStorage.getItem('nicotind:search-history')).toBeNull();
      expect(localStorage.getItem('nicotind:downloaded-folders')).toBeNull();
      expect(localStorage.getItem('nicotind-library-state')).toBeNull();
      expect(localStorage.getItem('nicotind-library-mode')).toBeNull();
      expect(localStorage.getItem('nicotind-library-show-hidden')).toBeNull();

      expect(localStorage.getItem('nicotind-theme')).toBe('{"state":{}}');
      expect(localStorage.getItem('nicotind_device_id')).toBe('device-123');
    });
  });
});

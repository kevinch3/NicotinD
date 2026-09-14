import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { Router } from '@angular/router';
import { TvChannelsService } from './tv-channels.service';
import { PlayerService } from '../player.service';
import { AuthService } from '../auth.service';
import { ServerConfigService } from '../server-config.service';
import { LibraryApiService } from '../api/library-api.service';
import { TranslateService } from '../translate.service';
import { signal } from '@angular/core';

describe('TvChannelsService (Play Next + Assistant voice)', () => {
  let listeners: Record<string, Array<(data: Record<string, string>) => void>>;
  let playSingle: ReturnType<typeof vi.fn>;
  let songs: ReturnType<typeof vi.fn>;
  let albums: ReturnType<typeof vi.fn>;
  let publishChannel: ReturnType<typeof vi.fn>;
  let clearChannel: ReturnType<typeof vi.fn>;
  let navigateByUrl: ReturnType<typeof vi.fn>;
  let token: ReturnType<typeof signal<string | null>>;

  function setup(platform: 'android' | 'web' = 'android') {
    listeners = {};
    playSingle = vi.fn();
    navigateByUrl = vi.fn();
    publishChannel = vi.fn().mockResolvedValue(undefined);
    clearChannel = vi.fn().mockResolvedValue(undefined);
    token = signal<string | null>('tok');
    songs = vi.fn(() =>
      of([
        { id: '1', title: 'Second Wind', artist: 'E2E Test Artist' },
        { id: '2', title: 'Quiet Hours', artist: 'E2E Test Artist' },
      ]),
    );
    albums = vi.fn(() =>
      of([
        { id: 'a1', name: 'E2E Test Album', artist: 'E2E Test Artist', coverArt: 'cov1' },
        { id: 'a2', name: 'Bare Album', artist: 'Someone' },
      ]),
    );
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => platform !== 'web',
      getPlatform: () => platform,
      Plugins: {
        NicotindTvChannels: {
          publishPlayNext: vi.fn().mockResolvedValue(undefined),
          clearPlayNext: vi.fn().mockResolvedValue(undefined),
          publishChannel,
          clearChannel,
          addListener: (event: string, cb: (data: Record<string, string>) => void) =>
            (listeners[event] ??= []).push(cb),
        },
      },
    };
    TestBed.configureTestingModule({
      providers: [
        TvChannelsService,
        {
          provide: PlayerService,
          useValue: { currentTrack: signal(null), playSingle },
        },
        { provide: AuthService, useValue: { token } },
        { provide: ServerConfigService, useValue: { apiUrl: (u: string) => `http://s${u}` } },
        { provide: LibraryApiService, useValue: { getAllSongs: songs, getAlbums: albums } },
        {
          provide: TranslateService,
          useValue: {
            ready: signal(true),
            lang: signal('en'),
            t: (k: string) => (k === 'tv.channelRecentlyAdded' ? 'Recently added' : k),
          },
        },
        { provide: Router, useValue: { navigateByUrl } },
      ],
    });
    const service = TestBed.inject(TvChannelsService);
    service.initialize();
    return service;
  }

  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it('registers the playFromSearch listener on Android only', () => {
    setup('android');
    expect(listeners['playFromSearch']?.length).toBe(1);
  });

  it('does nothing off the native Android shell', () => {
    setup('web');
    expect(listeners['playFromSearch']).toBeUndefined();
    expect(listeners['deepLink']).toBeUndefined();
  });

  it('a voice query searches the library and plays the best match', async () => {
    const service = setup('android');
    await service.playFromSearch('second wind');
    expect(songs).toHaveBeenCalledWith(50, 0, { q: 'second wind' });
    expect(playSingle).toHaveBeenCalledWith(
      expect.objectContaining({ id: '1', title: 'Second Wind' }),
    );
  });

  it('a query with no match plays nothing', async () => {
    const service = setup('android');
    await service.playFromSearch('zzz unrelated');
    expect(playSingle).not.toHaveBeenCalled();
  });

  it('publishes the newest albums as the channel row when signed in (issue #395)', async () => {
    const service = setup('android');
    await service.syncChannel();
    expect(albums).toHaveBeenCalledWith('newest', 12);
    expect(publishChannel).toHaveBeenCalledWith({
      title: 'Recently added',
      programs: [
        {
          title: 'E2E Test Album',
          subtitle: 'E2E Test Artist',
          coverUrl: 'http://s/api/cover/cov1?size=600&token=tok',
          route: '/library/albums/a1',
        },
        // No coverArt → no coverUrl key claiming art that will 404.
        { title: 'Bare Album', subtitle: 'Someone', route: '/library/albums/a2' },
      ],
    });
  });

  it('clears the channel when signed out', async () => {
    const service = setup('android');
    token.set(null);
    await service.syncChannel();
    expect(publishChannel).not.toHaveBeenCalled();
    expect(clearChannel).toHaveBeenCalled();
  });

  it('a deepLink event navigates to the in-app route', () => {
    setup('android');
    listeners['deepLink'][0]({ route: '/library/albums/a1' });
    expect(navigateByUrl).toHaveBeenCalledWith('/library/albums/a1');
  });

  it('a hostile deepLink route is sanitized to home, never followed', () => {
    // The route rides in an intent extra any app on the device can craft —
    // same trust level as a returnUrl query param (issue #231).
    setup('android');
    listeners['deepLink'][0]({ route: 'https://evil.example' });
    expect(navigateByUrl).toHaveBeenCalledWith('/');
  });
});

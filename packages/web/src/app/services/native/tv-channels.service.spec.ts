import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { TvChannelsService } from './tv-channels.service';
import { PlayerService } from '../player.service';
import { AuthService } from '../auth.service';
import { ServerConfigService } from '../server-config.service';
import { LibraryApiService } from '../api/library-api.service';
import { signal } from '@angular/core';

describe('TvChannelsService (Play Next + Assistant voice)', () => {
  let listeners: Array<(data: { query: string }) => void>;
  let playSingle: ReturnType<typeof vi.fn>;
  let songs: ReturnType<typeof vi.fn>;

  function setup(platform: 'android' | 'web' = 'android') {
    listeners = [];
    playSingle = vi.fn();
    songs = vi.fn(() =>
      of([
        { id: '1', title: 'Second Wind', artist: 'E2E Test Artist' },
        { id: '2', title: 'Quiet Hours', artist: 'E2E Test Artist' },
      ]),
    );
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => platform !== 'web',
      getPlatform: () => platform,
      Plugins: {
        NicotindTvChannels: {
          publishPlayNext: vi.fn().mockResolvedValue(undefined),
          clearPlayNext: vi.fn().mockResolvedValue(undefined),
          addListener: (_: string, cb: (data: { query: string }) => void) => listeners.push(cb),
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
        { provide: AuthService, useValue: { token: signal('tok') } },
        { provide: ServerConfigService, useValue: { apiUrl: (u: string) => `http://s${u}` } },
        { provide: LibraryApiService, useValue: { getAllSongs: songs } },
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
    expect(listeners.length).toBe(1);
  });

  it('does nothing off the native Android shell', () => {
    setup('web');
    expect(listeners.length).toBe(0);
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
});

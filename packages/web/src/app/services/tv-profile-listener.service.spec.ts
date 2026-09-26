import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import {
  TvProfileListenerService,
  PROFILE_CAST_LISTENER_FACTORY,
} from './tv-profile-listener.service';
import { TvProfileService } from './tv-profile.service';
import { RemotePlaybackService } from './remote-playback.service';
import { AuthService } from './auth.service';
import { PlaybackWsService } from './playback-ws.service';
import { ServerConfigService } from './server-config.service';
import type { ProfileCastListenerOptions } from '../lib/profile-cast-listener';
import type { TvProfile } from '../lib/tv-profiles';

const platform = vi.hoisted(() => ({ tv: true }));
vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return { ...actual, isTvBuild: vi.fn(() => platform.tv) };
});

const profile = (username: string, token: string): TvProfile => ({
  username,
  token,
  role: 'user',
  lastUsedAt: 0,
});

interface FakeListener {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  onCast: () => void;
  onRefused: () => void;
  releaseStaleOutput?: () => boolean;
}

describe('TvProfileListenerService', () => {
  let profiles: ReturnType<typeof signal<TvProfile[]>>;
  let active: ReturnType<typeof signal<string | null>>;
  let stale: ReturnType<typeof signal<ReadonlySet<string>>>;
  let outputAvailable: ReturnType<typeof signal<boolean>>;
  let syncedAs: ReturnType<typeof signal<string | null>>;
  let activation: ReturnType<typeof signal<boolean>>;
  let switchTo: ReturnType<typeof vi.fn>;
  let markStale: ReturnType<typeof vi.fn>;
  let created: Map<string, FakeListener>;
  let baseUrl: ReturnType<typeof signal<string>>;

  function create() {
    profiles = signal<TvProfile[]>([profile('ana', 'tok-ana'), profile('ben', 'tok-ben')]);
    active = signal<string | null>('ana');
    stale = signal<ReadonlySet<string>>(new Set());
    outputAvailable = signal(true);
    syncedAs = signal<string | null>('ana');
    activation = signal(false);
    switchTo = vi.fn();
    markStale = vi.fn();
    created = new Map();
    baseUrl = signal('http://srv');

    const authToken = signal<string | null>('tok');

    TestBed.configureTestingModule({
      providers: [
        {
          provide: TvProfileService,
          useValue: { profiles, active, stale, switchTo, markStale },
        },
        {
          provide: RemotePlaybackService,
          useValue: { outputAvailable, syncedAs },
        },
        {
          provide: AuthService,
          useValue: { token: authToken, username: active },
        },
        {
          provide: PlaybackWsService,
          useValue: {
            getDeviceId: () => 'tv-id',
            getDeviceName: () => 'NicotinD TV',
            isActivated: () => true,
            activation,
          },
        },
        {
          provide: ServerConfigService,
          useValue: {
            baseUrl,
            wsUrl: (p: string) => baseUrl().replace('http', 'ws') + p,
            apiUrl: (p: string) => baseUrl() + p,
          },
        },
        {
          provide: PROFILE_CAST_LISTENER_FACTORY,
          useValue: (opts: ProfileCastListenerOptions): FakeListener => {
            const listener: FakeListener = {
              start: vi.fn(),
              stop: vi.fn(),
              update: vi.fn(),
              onCast: opts.onCast,
              onRefused: opts.onRefused,
              releaseStaleOutput: opts.releaseStaleOutput,
            };
            created.set(opts.url, listener);
            return listener;
          },
        },
      ],
    });
    return { authToken };
  }

  function listenerFor(tok: string): FakeListener {
    const url =
      baseUrl().replace('http', 'ws') + '/api/ws/playback?token=' + encodeURIComponent(tok);
    const listener = created.get(url);
    if (!listener) throw new Error(`no listener opened for token ${tok}`);
    return listener;
  }

  afterEach(() => {
    platform.tv = true;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('off-TV: no listener is created', () => {
    platform.tv = false;
    create();
    const service = TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();
    expect(service.listening()).toEqual([]);
    expect(created.size).toBe(0);
  });

  it('opens one listener per stored person except the active one; the URL carries their token', () => {
    create();
    const service = TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();

    expect(service.listening()).toEqual(['ben']);
    const listener = listenerFor('tok-ben');
    expect(listener).toBeDefined();
    expect(listener.start).toHaveBeenCalled();
  });

  it('opens none while outputAvailable() is false or the token is null; turning it off stops the open ones', () => {
    const { authToken } = create();
    const service = TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();
    const listener = listenerFor('tok-ben');
    expect(service.listening()).toEqual(['ben']);

    outputAvailable.set(false);
    TestBed.flushEffects();
    expect(service.listening()).toEqual([]);
    expect(listener.stop).toHaveBeenCalled();

    outputAvailable.set(true);
    TestBed.flushEffects();
    expect(service.listening()).toEqual(['ben']);

    authToken.set(null);
    TestBed.flushEffects();
    expect(service.listening()).toEqual([]);
  });

  it('a stale person gets no listener', () => {
    create();
    stale.set(new Set(['ben']));
    const service = TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();

    expect(service.listening()).toEqual([]);
  });

  it('hands over: the outgoing listener stays open, the incoming one waits for sync, then they swap', () => {
    create();
    const service = TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();
    expect(service.listening()).toEqual(['ben']);
    const benListener = listenerFor('tok-ben');

    // Active flips to ben (a cast happened); syncedAs has not caught up yet.
    // Ana's listener must NOT open now — opening it before the server has
    // dropped ana's main socket would race that teardown.
    active.set('ben');
    TestBed.flushEffects();
    expect(service.listening()).toEqual(['ben']);
    expect(benListener.stop).not.toHaveBeenCalled();

    // The main socket finally re-registers as ben: ben's listener stops and
    // only now does ana's open.
    syncedAs.set('ben');
    TestBed.flushEffects();
    expect(service.listening()).toEqual(['ana']);
    expect(benListener.stop).toHaveBeenCalled();
  });

  it('at boot, with syncedAs still null, no listener opens until the main socket syncs as the active person', () => {
    create();
    syncedAs.set(null);
    const service = TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();
    expect(service.listening()).toEqual([]);

    syncedAs.set('ana');
    TestBed.flushEffects();
    expect(service.listening()).toEqual(['ben']);
  });

  it("a listener's onCast switches to that person, landing on the player", () => {
    create();
    TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();
    const listener = listenerFor('tok-ben');

    listener.onCast();

    expect(switchTo).toHaveBeenCalledWith('ben', { landing: '/player' });
  });

  it('onRefused confirmed by a raw 401 from /api/auth/me marks that person stale', async () => {
    const fetchStub = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchStub);
    create();
    TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();
    const listener = listenerFor('tok-ben');

    listener.onRefused();
    await vi.waitFor(() => expect(markStale).toHaveBeenCalledWith('ben'));

    expect(fetchStub).toHaveBeenCalledWith('http://srv/api/auth/me', {
      headers: { Authorization: 'Bearer tok-ben' },
    });
    expect(listener.stop).toHaveBeenCalled();
  });

  it('onRefused on a network error is an outage: no stale mark, a fresh listener after 30 s', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    create();
    const service = TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();
    const first = listenerFor('tok-ben');

    first.onRefused();
    await vi.advanceTimersByTimeAsync(0);
    TestBed.flushEffects();
    expect(service.listening()).toEqual([]);
    expect(markStale).not.toHaveBeenCalled();

    created.clear();
    await vi.advanceTimersByTimeAsync(30_000);
    TestBed.flushEffects();
    const second = listenerFor('tok-ben');
    expect(second).not.toBe(first);
    expect(second.start).toHaveBeenCalled();
    expect(service.listening()).toEqual(['ben']);
    expect(markStale).not.toHaveBeenCalled();
  });

  it('a stale echo is released only by listeners for people the TV is not switching to', () => {
    create();
    TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();
    const listener = listenerFor('tok-ben');
    expect(listener.releaseStaleOutput?.()).toBe(true);
    active.set('ben');
    expect(listener.releaseStaleOutput?.()).toBe(false);
  });

  it('a server switch stops the old listener and opens one against the new server', () => {
    create();
    const service = TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();
    const old = listenerFor('tok-ben');

    baseUrl.set('http://other');
    TestBed.flushEffects();

    expect(old.stop).toHaveBeenCalled();
    const fresh = created.get('ws://other/api/ws/playback?token=tok-ben');
    expect(fresh?.start).toHaveBeenCalled();
    expect(service.listening()).toEqual(['ben']);
  });

  it('activation flipping to true updates every open listener', () => {
    create();
    TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();
    const listener = listenerFor('tok-ben');
    expect(listener.update).not.toHaveBeenCalled();

    activation.set(true);
    TestBed.flushEffects();

    expect(listener.update).toHaveBeenCalledWith({ activated: true });
  });
});

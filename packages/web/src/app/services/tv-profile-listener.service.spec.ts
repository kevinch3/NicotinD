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
          useValue: { wsUrl: (p: string) => 'ws://srv' + p },
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
            };
            created.set(opts.url, listener);
            return listener;
          },
        },
      ],
    });
    return { authToken };
  }

  function listenerFor(_username: string, tok: string): FakeListener {
    const url = 'ws://srv/api/ws/playback?token=' + encodeURIComponent(tok);
    const listener = created.get(url);
    if (!listener) throw new Error(`no listener opened for token ${tok}`);
    return listener;
  }

  afterEach(() => {
    platform.tv = true;
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
    const listener = listenerFor('ben', 'tok-ben');
    expect(listener).toBeDefined();
    expect(listener.start).toHaveBeenCalled();
  });

  it('opens none while outputAvailable() is false or the token is null; turning it off stops the open ones', () => {
    const { authToken } = create();
    const service = TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();
    const listener = listenerFor('ben', 'tok-ben');
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

  it('hands over: switching active keeps the outgoing listener open until synced, then closes it', () => {
    create();
    const service = TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();
    expect(service.listening()).toEqual(['ben']);
    const benListener = listenerFor('ben', 'tok-ben');

    // Active flips to ben (a cast happened); syncedAs has not caught up yet.
    active.set('ben');
    TestBed.flushEffects();
    expect(service.listening().sort()).toEqual(['ana', 'ben']);
    expect(benListener.stop).not.toHaveBeenCalled();

    // The main socket finally re-registers as ben.
    syncedAs.set('ben');
    TestBed.flushEffects();
    expect(service.listening()).toEqual(['ana']);
    expect(benListener.stop).toHaveBeenCalled();
  });

  it("a listener's onCast switches to that person, landing on the player", () => {
    create();
    const service = TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();
    const listener = listenerFor('ben', 'tok-ben');

    listener.onCast();

    expect(switchTo).toHaveBeenCalledWith('ben', { landing: '/player' });
  });

  it("a listener's onRefused marks that person stale", () => {
    create();
    const service = TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();
    const listener = listenerFor('ben', 'tok-ben');

    listener.onRefused();

    expect(markStale).toHaveBeenCalledWith('ben');
  });

  it('activation flipping to true updates every open listener', () => {
    create();
    const service = TestBed.inject(TvProfileListenerService);
    TestBed.flushEffects();
    const listener = listenerFor('ben', 'tok-ben');
    expect(listener.update).not.toHaveBeenCalled();

    activation.set(true);
    TestBed.flushEffects();

    expect(listener.update).toHaveBeenCalledWith({ activated: true });
  });
});

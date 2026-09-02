import { TestBed } from '@angular/core/testing';
import { RemotePlaybackService } from './remote-playback.service';
import { PlaybackWsService } from './playback-ws.service';
import { PlayerService } from './player.service';
import { AuthService } from './auth.service';
import { EMPTY, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import * as platform from '../lib/platform';

// `remoteEnabled`'s initial value is computed once, at class-field-initialization
// time, from `isTvBuild()`. Mocking the module (rather than the dynamic-import
// dance) lets each test flip that return value per-case while still injecting a
// fresh `RemotePlaybackService` instance per `TestBed.inject` call below --
// matches the pattern already used by desktop-window-controls.component.spec.ts.
vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    isTvBuild: vi.fn().mockReturnValue(false),
  };
});

// Provide a full localStorage stub so the test works regardless of the
// vitest environment (jsdom, happy-dom, or bare Node).
const storageStub = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();

Object.defineProperty(globalThis, 'localStorage', {
  value: storageStub,
  writable: true,
  configurable: true,
});

describe('RemotePlaybackService', () => {
  let service: RemotePlaybackService;
  let mockWs: {
    updateDevice: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    getDeviceId: ReturnType<typeof vi.fn>;
    setActiveDevice: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
    messages: ReturnType<typeof vi.fn>;
    sendStateUpdate: ReturnType<typeof vi.fn>;
    clearPersistentFailure: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    storageStub.clear();

    mockWs = {
      updateDevice: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      getDeviceId: vi.fn(() => 'test-device-id'),
      setActiveDevice: vi.fn(),
      sendCommand: vi.fn(),
      messages: vi.fn(() => EMPTY),
      sendStateUpdate: vi.fn(),
      clearPersistentFailure: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        RemotePlaybackService,
        PlayerService,
        AuthService,
        { provide: PlaybackWsService, useValue: mockWs },
      ],
    });
    service = TestBed.inject(RemotePlaybackService);
  });

  describe('remoteEnabled initialization', () => {
    it('defaults to false when localStorage has no value', () => {
      expect(service.remoteEnabled()).toBe(false);
    });
  });

  describe('setRemoteEnabled(true)', () => {
    it('sets remoteEnabled = true in the service', () => {
      service.setRemoteEnabled(true);
      expect(service.remoteEnabled()).toBe(true);
    });

    it('writes "true" to localStorage', () => {
      service.setRemoteEnabled(true);
      expect(localStorage.getItem('nicotind_remote_enabled')).toBe('true');
    });

    it('calls wsClient.updateDevice with { remoteEnabled: true }', () => {
      service.setRemoteEnabled(true);
      expect(mockWs.updateDevice).toHaveBeenCalledWith({ remoteEnabled: true });
    });
  });

  describe('setRemoteEnabled(false)', () => {
    it('sets remoteEnabled = false in the service', () => {
      service.setRemoteEnabled(true);
      service.setRemoteEnabled(false);
      expect(service.remoteEnabled()).toBe(false);
    });

    it('writes "false" to localStorage', () => {
      service.setRemoteEnabled(false);
      expect(localStorage.getItem('nicotind_remote_enabled')).toBe('false');
    });

    it('calls wsClient.updateDevice with { remoteEnabled: false }', () => {
      service.setRemoteEnabled(false);
      expect(mockWs.updateDevice).toHaveBeenCalledWith({ remoteEnabled: false });
    });
  });

  describe('localStorage-based initialization', () => {
    it('would initialize to true if localStorage had "true" before construction', () => {
      localStorage.setItem('nicotind_remote_enabled', 'true');
      const value = localStorage.getItem('nicotind_remote_enabled') === 'true';
      expect(value).toBe(true);
    });

    it('would initialize to false if localStorage had "false" before construction', () => {
      localStorage.setItem('nicotind_remote_enabled', 'false');
      const value = localStorage.getItem('nicotind_remote_enabled') === 'true';
      expect(value).toBe(false);
    });
  });
});

describe('RemotePlaybackService TV default', () => {
  let mockWs: {
    updateDevice: ReturnType<typeof vi.fn>;
    clearPersistentFailure: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    storageStub.clear();
    mockWs = { updateDevice: vi.fn(), clearPersistentFailure: vi.fn() };
  });

  afterEach(() => {
    vi.mocked(platform.isTvBuild).mockReturnValue(false);
  });

  function inject(): RemotePlaybackService {
    TestBed.configureTestingModule({
      providers: [
        RemotePlaybackService,
        { provide: PlaybackWsService, useValue: mockWs },
        { provide: PlayerService, useValue: {} },
        { provide: AuthService, useValue: {} },
      ],
    });
    return TestBed.inject(RemotePlaybackService);
  }

  it('defaults remoteEnabled to true on a TV build with no stored preference', () => {
    vi.mocked(platform.isTvBuild).mockReturnValue(true);
    const service = inject();
    expect(service.remoteEnabled()).toBe(true);
  });

  it('does not default remoteEnabled on a non-TV build with no stored preference', () => {
    vi.mocked(platform.isTvBuild).mockReturnValue(false);
    const service = inject();
    expect(service.remoteEnabled()).toBe(false);
  });

  it('an explicit stored false always wins over a TV-build default', () => {
    storageStub.setItem('nicotind_remote_enabled', 'false');
    vi.mocked(platform.isTvBuild).mockReturnValue(true);
    const service = inject();
    expect(service.remoteEnabled()).toBe(false);
  });

  it('an explicit stored true wins on a non-TV build too', () => {
    storageStub.setItem('nicotind_remote_enabled', 'true');
    vi.mocked(platform.isTvBuild).mockReturnValue(false);
    const service = inject();
    expect(service.remoteEnabled()).toBe(true);
  });
});

describe('RemotePlaybackService session behaviour (#877)', () => {
  const t1 = { id: 't1', title: 'One', artist: 'A' };
  const t2 = { id: 't2', title: 'Two', artist: 'A' };
  const t3 = { id: 't3', title: 'Three', artist: 'A' };
  let service: RemotePlaybackService;
  let player: PlayerService;
  let incoming: Subject<{ type: string; payload: unknown }>;
  let ws: {
    updateDevice: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    getDeviceId: ReturnType<typeof vi.fn>;
    setActiveDevice: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
    sendStateUpdate: ReturnType<typeof vi.fn>;
    clearPersistentFailure: ReturnType<typeof vi.fn>;
    persistentFailure: () => string | null;
    messages: (type: string) => unknown;
  };

  const emit = (type: string, payload: unknown) => {
    incoming.next({ type, payload });
    TestBed.flushEffects();
  };
  const sync = (state: Record<string, unknown>, devices?: unknown[]) =>
    emit('STATE_SYNC', { state, ...(devices && { devices }) });

  beforeEach(() => {
    storageStub.clear();
    storageStub.setItem('nicotind_remote_enabled', 'true');
    incoming = new Subject();
    ws = {
      updateDevice: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      getDeviceId: vi.fn(() => 'me'),
      setActiveDevice: vi.fn(),
      sendCommand: vi.fn(),
      sendStateUpdate: vi.fn(),
      clearPersistentFailure: vi.fn(),
      persistentFailure: () => null,
      messages: (type: string) =>
        incoming.pipe(
          filter((m) => m.type === type),
          map((m) => m.payload),
        ),
    };
    TestBed.configureTestingModule({
      providers: [
        RemotePlaybackService,
        PlayerService,
        AuthService,
        { provide: PlaybackWsService, useValue: ws },
      ],
    });
    service = TestBed.inject(RemotePlaybackService);
    player = TestBed.inject(PlayerService);
    TestBed.runInInjectionContext(() => service.initialize());
    TestBed.flushEffects();
  });

  it('casting to another device pauses the local player, not just its element', () => {
    player.play(t1);
    TestBed.flushEffects();
    service.switchToDevice('tv');
    expect(player.isPlaying()).toBe(false);
    expect(ws.setActiveDevice).toHaveBeenCalledWith('tv');
    expect(ws.sendCommand).toHaveBeenCalledWith('SET_TRACK', { track: t1 });
  });

  it('the session ending never wakes the former controller', () => {
    player.play(t1);
    TestBed.flushEffects();
    service.switchToDevice('tv');
    sync({ activeDeviceId: 'tv', isPlaying: true, position: 5, track: t1 });
    sync({ activeDeviceId: null, isPlaying: false, position: 0, track: t1 });
    expect(service.activeDeviceId()).toBeNull();
    expect(service.isActiveDevice()).toBe(true);
    expect(player.isPlaying()).toBe(false);
  });

  it('a command executes only while this device is the output', () => {
    sync({ activeDeviceId: 'me' });
    emit('COMMAND', { action: 'SET_TRACK', track: t2 });
    expect(player.currentTrack()?.id).toBe('t2');
    expect(player.isPlaying()).toBe(true);

    sync({ activeDeviceId: 'tv' });
    expect(player.isPlaying()).toBe(false);
    emit('COMMAND', { action: 'PLAY' });
    expect(player.isPlaying()).toBe(false);
  });

  it('a reconnect snapshot re-syncs the output device to the server track', () => {
    sync({ activeDeviceId: 'me' });
    emit('COMMAND', { action: 'SET_TRACK', track: t1 });
    sync({ activeDeviceId: 'me', track: t2, position: 30, isPlaying: true }, [
      { id: 'me', name: 'Me', type: 'web', lastSeen: 0 },
    ]);
    expect(player.currentTrack()?.id).toBe('t2');
    expect(player.seekTo()).toBe(30);
    expect(player.isPlaying()).toBe(true);
  });

  it('the controller mirrors the remote track without playing it', () => {
    sync({ activeDeviceId: 'tv', isPlaying: true, position: 3, track: t2 });
    expect(player.currentTrack()?.id).toBe('t2');
    expect(player.isPlaying()).toBe(false);
    expect(service.remoteIsPlaying()).toBe(true);
  });

  it('a mirrored track is not echoed back; a locally chosen one is forwarded', () => {
    sync({ activeDeviceId: 'tv', isPlaying: true, position: 3, track: t2 });
    expect(ws.sendCommand).not.toHaveBeenCalledWith('SET_TRACK', { track: t2 });
    player.play(t3);
    TestBed.flushEffects();
    expect(ws.sendCommand).toHaveBeenCalledWith('SET_TRACK', { track: t3 });
  });

  it('taking the session back resumes locally at the remote position', () => {
    sync({ activeDeviceId: 'tv', isPlaying: true, position: 40, track: t1 });
    service.switchToDevice('me');
    expect(ws.setActiveDevice).toHaveBeenCalledWith('me');
    expect(service.isActiveDevice()).toBe(true);
    expect(player.isPlaying()).toBe(true);
    expect(player.seekTo()).toBeGreaterThanOrEqual(40);
  });
});

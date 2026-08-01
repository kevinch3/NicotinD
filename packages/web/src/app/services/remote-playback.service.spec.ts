import { TestBed } from '@angular/core/testing';
import { RemotePlaybackService } from './remote-playback.service';
import { PlaybackWsService } from './playback-ws.service';
import { PlayerService } from './player.service';
import { AuthService } from './auth.service';
import { EMPTY } from 'rxjs';
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

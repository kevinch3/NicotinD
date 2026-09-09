import { TestBed } from '@angular/core/testing';
import { RemotePlaybackService } from './remote-playback.service';
import { PlaybackWsService } from './playback-ws.service';
import { PlayerService } from './player.service';
import { AuthService } from './auth.service';
import { EMPTY, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';

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

describe('RemotePlaybackService — the "available as an output" preference', () => {
  let mockWs: {
    updateDevice: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    getDeviceId: ReturnType<typeof vi.fn>;
    messages: ReturnType<typeof vi.fn>;
    persistentFailure: ReturnType<typeof vi.fn>;
    markActivated: ReturnType<typeof vi.fn>;
    sendRelease: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    storageStub.clear();
    mockWs = {
      updateDevice: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      getDeviceId: vi.fn(() => 'test-device-id'),
      messages: vi.fn(() => EMPTY),
      persistentFailure: vi.fn(() => null),
      markActivated: vi.fn(),
      sendRelease: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [
        RemotePlaybackService,
        PlayerService,
        AuthService,
        { provide: PlaybackWsService, useValue: mockWs },
      ],
    });
  });

  const inject = () => TestBed.inject(RemotePlaybackService);

  it('is ON by default on every platform', () => {
    expect(inject().outputAvailable()).toBe(true);
  });

  it('an explicit stored "false" is the only way off', () => {
    storageStub.setItem('nicotind_remote_available', 'false');
    expect(inject().outputAvailable()).toBe(false);
  });

  it('the old opt-in key is not consulted — its meaning changed', () => {
    storageStub.setItem('nicotind_remote_enabled', 'false');
    expect(inject().outputAvailable()).toBe(true);
  });

  it('turning it off persists, tells the server, and updates the signal', () => {
    const service = inject();
    service.setOutputAvailable(false);
    expect(localStorage.getItem('nicotind_remote_available')).toBe('false');
    expect(mockWs.updateDevice).toHaveBeenCalledWith({ remoteEnabled: false });
    expect(service.outputAvailable()).toBe(false);
    service.setOutputAvailable(true);
    expect(localStorage.getItem('nicotind_remote_available')).toBe('true');
    expect(mockWs.updateDevice).toHaveBeenCalledWith({ remoteEnabled: true });
  });

  it('the socket is the presence channel: it connects while logged in even with the toggle off', () => {
    storageStub.setItem('nicotind_remote_available', 'false');
    const service = inject();
    const auth = TestBed.inject(AuthService);
    auth.token.set('tok');
    TestBed.runInInjectionContext(() => service.initialize());
    TestBed.flushEffects();
    expect(mockWs.connect).toHaveBeenCalled();
    expect(mockWs.disconnect).not.toHaveBeenCalled();
  });

  it('a persistent connection failure is reported, never written into the preference', () => {
    mockWs.persistentFailure.mockReturnValue('Connection failed');
    const service = inject();
    TestBed.runInInjectionContext(() => service.initialize());
    TestBed.flushEffects();
    expect(service.syncStatus()).toBe('Connection failed');
    expect(service.outputAvailable()).toBe(true);
    expect(localStorage.getItem('nicotind_remote_available')).toBeNull();
  });
});

describe('RemotePlaybackService session behaviour (#877)', () => {
  const t1 = { id: 't1', title: 'One', artist: 'A' };
  const t2 = { id: 't2', title: 'Two', artist: 'A' };
  const t3 = { id: 't3', title: 'Three', artist: 'A' };
  const tvDevice = { id: 'tv', name: 'TV', type: 'web', lastSeen: 0 };
  const meDevice = { id: 'me', name: 'Me', type: 'web', lastSeen: 0 };
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
    sendClaim: ReturnType<typeof vi.fn>;
    sendRelease: ReturnType<typeof vi.fn>;
    markActivated: ReturnType<typeof vi.fn>;
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
    incoming = new Subject();
    ws = {
      updateDevice: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      getDeviceId: vi.fn(() => 'me'),
      setActiveDevice: vi.fn(),
      sendCommand: vi.fn(),
      sendStateUpdate: vi.fn(),
      sendClaim: vi.fn(),
      sendRelease: vi.fn(),
      markActivated: vi.fn(),
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
    sync({ activeDeviceId: 'tv', isPlaying: true, position: 3, track: t2 }, [tvDevice]);
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

  // --- claim-on-play -------------------------------------------------------

  it('a pick with no session claims the output with the track, and commits nothing until the sync', () => {
    sync({ activeDeviceId: null }, [meDevice, tvDevice]);
    player.play(t1);
    TestBed.flushEffects();
    expect(ws.sendClaim).toHaveBeenCalledTimes(1);
    expect(ws.sendClaim).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: 't1', isPlaying: true }),
    );
    expect(ws.setActiveDevice).not.toHaveBeenCalled();
    expect(service.activeDeviceId()).toBeNull();
    sync({ activeDeviceId: 'me', track: t1, isPlaying: true, position: 0 });
    expect(service.isActiveDevice()).toBe(true);
    expect(service.playingElsewhere()).toBe(false);
  });

  it('a pick while another device is the output goes to that device, not a claim', () => {
    sync({ activeDeviceId: 'tv', isPlaying: true, position: 3, track: t2 }, [meDevice, tvDevice]);
    player.play(t3);
    TestBed.flushEffects();
    expect(ws.sendClaim).not.toHaveBeenCalled();
    expect(ws.sendCommand).toHaveBeenCalledWith('SET_TRACK', { track: t3 });
    expect(service.playingElsewhere()).toBe(true);
    expect(service.sessionControllable()).toBe(true);
  });

  it('a pick while the output cannot be driven claims instead', () => {
    sync({ activeDeviceId: 'tv', isPlaying: true, position: 3, track: t2 }, [
      meDevice,
      { ...tvDevice, available: false },
    ]);
    expect(service.sessionControllable()).toBe(false);
    player.play(t3);
    TestBed.flushEffects();
    expect(ws.sendCommand).not.toHaveBeenCalledWith('SET_TRACK', expect.anything());
    expect(ws.sendClaim).toHaveBeenCalledTimes(1);
  });

  it('losing a claim race yields: the private sync names the winner and this player pauses', () => {
    sync({ activeDeviceId: null }, [meDevice, tvDevice]);
    player.play(t1);
    TestBed.flushEffects();
    sync({ activeDeviceId: 'tv', track: t2, isPlaying: true, position: 1 }, [meDevice, tvDevice]);
    expect(player.isPlaying()).toBe(false);
    expect(player.currentTrack()?.id).toBe('t2');
    expect(service.playingElsewhere()).toBe(true);
  });

  it('the output reports its own pause and resume as state', () => {
    sync({ activeDeviceId: null }, [meDevice, tvDevice]);
    player.play(t1);
    TestBed.flushEffects();
    sync({ activeDeviceId: 'me', track: t1, isPlaying: true, position: 0 });
    ws.sendStateUpdate.mockClear();
    player.pause();
    TestBed.flushEffects();
    expect(ws.sendStateUpdate).toHaveBeenCalledWith(expect.objectContaining({ isPlaying: false }));
    player.resume();
    TestBed.flushEffects();
    expect(ws.sendStateUpdate).toHaveBeenCalledWith(expect.objectContaining({ isPlaying: true }));
  });

  it('a restored (paused) track at boot is not forwarded anywhere', () => {
    player.setCurrentTrackMetadata(t1 as never);
    TestBed.flushEffects();
    expect(ws.sendCommand).not.toHaveBeenCalled();
    expect(ws.sendStateUpdate).not.toHaveBeenCalled();
    expect(ws.sendClaim).not.toHaveBeenCalled();
  });

  it('the first gesture marks this tab as able to play', () => {
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(ws.markActivated).toHaveBeenCalled();
  });

  it('a closing tab releases the output it holds', () => {
    sync({ activeDeviceId: 'me' }, [meDevice]);
    window.dispatchEvent(new Event('pagehide'));
    expect(ws.sendRelease).toHaveBeenCalled();
    ws.sendRelease.mockClear();
    sync({ activeDeviceId: 'tv' }, [meDevice, tvDevice]);
    window.dispatchEvent(new Event('pagehide'));
    expect(ws.sendRelease).not.toHaveBeenCalled();
  });

  it('activeDevice names the session device from the list', () => {
    sync({ activeDeviceId: 'tv' }, [meDevice, tvDevice]);
    expect(service.activeDevice()?.name).toBe('TV');
    sync({ activeDeviceId: null });
    expect(service.activeDevice()).toBeNull();
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { MediaControlsService } from './media-controls.service';
import type { MediaMetadataInit } from '../lib/media-metadata';

// Mimic the @jofr `MediaSession` Capacitor proxy: a `.then` getter that throws
// (the real proxy turns `.then` access into a rejecting native call on web). If
// the service ever lets a Promise resolve to this object directly, the Promise
// machinery probes `.then` → `thenProbe()` fires → the regression is back.
const jofr = vi.hoisted(() => {
  const thenProbe = vi.fn();
  const session = {
    get then() {
      thenProbe();
      return undefined;
    },
    setMetadata: vi.fn().mockResolvedValue(undefined),
    setPlaybackState: vi.fn().mockResolvedValue(undefined),
    setPositionState: vi.fn().mockResolvedValue(undefined),
    setActionHandler: vi.fn().mockResolvedValue(undefined),
  };
  return { thenProbe, session };
});

vi.mock('@jofr/capacitor-media-session', () => ({ MediaSession: jofr.session }));

const flush = () => new Promise((r) => setTimeout(r, 0));

type CapStub = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
};

type RemoteCommandCb = (e: { action: string; seekTime?: number }) => void;

function nativePlugin() {
  const listeners: RemoteCommandCb[] = [];
  return {
    setMetadata: vi.fn().mockResolvedValue(undefined),
    setPlaybackState: vi.fn().mockResolvedValue(undefined),
    setPositionState: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    addListener: vi.fn((_event: string, cb: RemoteCommandCb) => {
      listeners.push(cb);
      return Promise.resolve({ remove: vi.fn() });
    }),
    getDiagnostics: vi.fn().mockResolvedValue({ pluginRegistered: true }),
    /** Test helper: simulate a native lock-screen command. */
    emit(action: string, seekTime?: number) {
      for (const cb of listeners) cb({ action, seekTime });
    },
  };
}

function asIos(plugin: ReturnType<typeof nativePlugin>): void {
  (globalThis as { Capacitor?: CapStub }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    Plugins: { NicotindNowPlaying: plugin },
  };
}

afterEach(() => {
  delete (globalThis as { Capacitor?: CapStub }).Capacitor;
});

const META: MediaMetadataInit = {
  title: 'T',
  artist: 'A',
  album: 'Alb',
  artwork: [
    { src: 'small', sizes: '96x96', type: 'image/jpeg' },
    { src: 'big', sizes: '512x512', type: 'image/jpeg' },
  ],
};

describe('MediaControlsService — iOS native routing', () => {
  it('routes metadata to the native Now Playing plugin (mapped, largest artwork)', () => {
    const plugin = nativePlugin();
    asIos(plugin);
    new MediaControlsService().setMetadata(META);
    expect(plugin.setMetadata).toHaveBeenCalledWith({
      title: 'T',
      artist: 'A',
      album: 'Alb',
      artworkUrl: 'big',
    });
  });

  it('routes playback state to the native plugin', () => {
    const plugin = nativePlugin();
    asIos(plugin);
    new MediaControlsService().setPlaybackState('playing');
    expect(plugin.setPlaybackState).toHaveBeenCalledWith({ state: 'playing' });
  });

  it('routes a valid position to the native plugin', () => {
    const plugin = nativePlugin();
    asIos(plugin);
    new MediaControlsService().setPositionState(200, 42);
    expect(plugin.setPositionState).toHaveBeenCalledWith({
      duration: 200,
      position: 42,
      playbackRate: 1,
    });
  });

  it('drops an invalid position before reaching the plugin', () => {
    const plugin = nativePlugin();
    asIos(plugin);
    const svc = new MediaControlsService();
    svc.setPositionState(0, 10); // duration <= 0
    svc.setPositionState(NaN, 10);
    expect(plugin.setPositionState).not.toHaveBeenCalled();
  });

  it('routes transport through the native remoteCommand event, not @jofr', () => {
    const plugin = nativePlugin();
    asIos(plugin);
    const svc = new MediaControlsService();
    const play = vi.fn();
    svc.setActionHandler('play', play);
    expect(plugin.addListener).toHaveBeenCalledWith('remoteCommand', expect.any(Function));
    // The web (@jofr) action-handler path must NOT be used on iOS (no double-fire).
    expect(jofr.session.setActionHandler).not.toHaveBeenCalled();
    plugin.emit('play');
    expect(play).toHaveBeenCalledWith(null);
  });

  it('attaches the remoteCommand listener only once across handlers', () => {
    const plugin = nativePlugin();
    asIos(plugin);
    const svc = new MediaControlsService();
    svc.setActionHandler('play', vi.fn());
    svc.setActionHandler('pause', vi.fn());
    svc.setActionHandler('nexttrack', vi.fn());
    expect(plugin.addListener).toHaveBeenCalledTimes(1);
  });

  it('dispatches each native action to its own handler, with seekTime only for seekto', () => {
    const plugin = nativePlugin();
    asIos(plugin);
    const svc = new MediaControlsService();
    const pause = vi.fn();
    const seek = vi.fn();
    svc.setActionHandler('pause', pause);
    svc.setActionHandler('seekto', seek);
    plugin.emit('pause');
    plugin.emit('seekto', 42);
    expect(pause).toHaveBeenCalledWith(null);
    expect(seek).toHaveBeenCalledWith(42);
  });

  it('exposes native diagnostics', async () => {
    const plugin = nativePlugin();
    asIos(plugin);
    const diag = await new MediaControlsService().getDiagnostics();
    expect(plugin.getDiagnostics).toHaveBeenCalled();
    expect(diag).toEqual({ pluginRegistered: true });
  });
});

describe('MediaControlsService — web (@jofr) path', () => {
  afterEach(() => {
    jofr.thenProbe.mockClear();
    jofr.session.setActionHandler.mockClear();
    jofr.session.setMetadata.mockClear();
  });

  it('invokes the @jofr session without probing the proxy.then (regression: MediaSession.then())', async () => {
    // No Capacitor global → not iOS-native → routes to @jofr.
    new MediaControlsService().setActionHandler('play', () => {});
    await flush();
    expect(jofr.session.setActionHandler).toHaveBeenCalled();
    // The fix boxes the proxy so Promise resolution never reads its `.then`.
    expect(jofr.thenProbe).not.toHaveBeenCalled();
  });

  it('routes metadata to @jofr on web (mapped through, not the native shape)', async () => {
    new MediaControlsService().setMetadata(META);
    await flush();
    expect(jofr.session.setMetadata).toHaveBeenCalledWith(META);
    expect(jofr.thenProbe).not.toHaveBeenCalled();
  });

  it('has no native diagnostics on web', async () => {
    expect(await new MediaControlsService().getDiagnostics()).toBeNull();
  });
});

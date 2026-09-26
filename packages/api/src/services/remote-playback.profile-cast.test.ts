import { afterEach, describe, expect, it } from 'bun:test';
import type { WSContext } from 'hono/ws';
import { createPlaybackHub } from './websocket.js';
import { PlaybackStateManager } from './playback-state.js';

/**
 * A TV switching profiles (#1406), server side: the outgoing person's main
 * socket closes and, a moment later, that person's cast listener registers the
 * SAME device id under their token. The re-register lands inside the 15 s grace
 * and cancels it, so without an explicit release the session names the TV
 * forever. These drive the real hub and manager, one fresh raw socket per
 * connection and a fresh WSContext per event, like Hono's Bun adapter.
 */

type Frame = { type: string; payload: Record<string, unknown> };
type Handlers = ReturnType<ReturnType<typeof createPlaybackHub>['handlersFor']>;

const TV = 'tv-1:tab-1';
let seq = 0;

class Socket {
  readonly raw = { socket: ++seq };
  readonly received: Frame[] = [];
  closed = false;

  constructor(private readonly handlers: Handlers) {}

  private ctx(): WSContext {
    return {
      raw: this.raw,
      send: (data: string) => this.received.push(JSON.parse(data) as Frame),
    } as unknown as WSContext;
  }

  send(type: string, payload: Record<string, unknown> = {}): void {
    this.handlers.onMessage!(
      { data: JSON.stringify({ type, payload }) } as MessageEvent,
      this.ctx(),
    );
  }

  register(id = TV): void {
    this.send('REGISTER', { id, name: id, deviceType: 'web', remoteEnabled: true });
  }

  /** activeDeviceId in the registration echo. */
  echoActive(): string | null {
    const echo = this.received.find((f) => f.type === 'STATE_SYNC' && 'devices' in f.payload);
    if (!echo) throw new Error('no registration echo');
    return (echo.payload['state'] as { activeDeviceId: string | null }).activeDeviceId;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose!({} as CloseEvent, this.ctx());
  }
}

const open: Socket[] = [];

/** Person A's session with the TV playing: a manager with the real 15 s grace. */
function aPlayingOnTheTv() {
  const manager = new PlaybackStateManager();
  const handlers = createPlaybackHub({ getOrCreate: () => manager }).handlersFor(`pc-${++seq}`);
  const socket = () => {
    const s = new Socket(handlers);
    open.push(s);
    return s;
  };
  const main = socket();
  main.register();
  main.send('CLAIM_OUTPUT', { track: { id: 't1' }, trackId: 't1', position: 0, isPlaying: true });
  expect(manager.getState().activeDeviceId).toBe(TV);
  expect(manager.getState().isPlaying).toBe(true);
  return { manager, main, socket };
}

afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

describe('a profile switch releases the outgoing session (#1406)', () => {
  it('unfixed shape: a bare close then a re-register inside the grace keeps the session on the TV', () => {
    // This is why both releases exist: the listener's REGISTER cancels the
    // grace the close started, and nothing ever ends the session after that.
    const { manager, main, socket } = aPlayingOnTheTv();
    main.close();
    const listener = socket();
    listener.register();
    expect(manager.getState().activeDeviceId).toBe(TV);
    expect(manager.getState().isPlaying).toBe(true);
    expect(manager.canTarget(TV)).toBe(true);
  });

  it('the main socket releasing before it closes: the listener registers into an ended session', () => {
    const { manager, main, socket } = aPlayingOnTheTv();
    main.send('RELEASE_OUTPUT');
    main.close();
    const listener = socket();
    listener.register();
    expect(listener.echoActive()).toBeNull();
    expect(manager.getState().activeDeviceId).toBeNull();
    expect(manager.getState().isPlaying).toBe(false);
  });

  it('the listener releasing on an echo that names the TV: the session ends', () => {
    const { manager, main, socket } = aPlayingOnTheTv();
    main.close();
    const listener = socket();
    listener.register();
    expect(listener.echoActive()).toBe(TV);
    listener.send('RELEASE_OUTPUT');
    expect(manager.getState().activeDeviceId).toBeNull();
    expect(manager.getState().isPlaying).toBe(false);
  });
});

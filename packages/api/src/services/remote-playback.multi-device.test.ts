import { afterEach, describe, expect, it } from 'bun:test';
import type { WSContext } from 'hono/ws';
import { createPlaybackHub } from './websocket.js';
import { PlaybackStateManager, type PlaybackStateOptions } from './playback-state.js';

/**
 * Virtual multi-device harness, server side (issue #877).
 *
 * The real PlaybackStateManager and the real handlers, driven by virtual
 * sockets that model Hono's Bun adapter faithfully: a NEW `WSContext` object
 * for every event (`open`, each `message`, `close`), all wrapping the same raw
 * Bun socket. The old handler map was keyed by `WSContext`, so nothing after
 * REGISTER could ever be attributed to its connection — heartbeats, progress,
 * opt-out and close were all silently dropped, and the unit tests never saw it
 * because they reused one mock object across calls.
 */

type Frame = { type: string; payload: Record<string, unknown> };
type Handlers = ReturnType<ReturnType<typeof createPlaybackHub>['handlersFor']>;

let seq = 0;

class VirtualSocket {
  readonly raw = { socket: ++seq };
  readonly received: Frame[] = [];
  closed = false;

  constructor(
    private readonly handlers: Handlers,
    readonly deviceId: string,
  ) {}

  /** A fresh WSContext per event, exactly like the adapter. */
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

  register(overrides: Record<string, unknown> = {}): void {
    this.send('REGISTER', {
      id: this.deviceId,
      name: this.deviceId,
      deviceType: 'web',
      remoteEnabled: true,
      ...overrides,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose!({} as CloseEvent, this.ctx());
  }

  frames(type: string): Frame[] {
    return this.received.filter((f) => f.type === type);
  }

  last(type: string): Frame | undefined {
    return this.frames(type).at(-1);
  }

  /** activeDeviceId as last told to this socket, `'∅'` if never told. */
  lastActive(): string | null | '∅' {
    const f = this.last('STATE_SYNC');
    if (!f) return '∅';
    return (f.payload['state'] as { activeDeviceId: string | null }).activeDeviceId;
  }

  lastDeviceIds(): string[] | undefined {
    const f = this.last('DEVICES_SYNC');
    return f ? (f.payload['devices'] as { id: string }[]).map((d) => d.id) : undefined;
  }

  /** Ids the last DEVICES_SYNC offered as targets. */
  lastAvailable(): string[] | undefined {
    const f = this.last('DEVICES_SYNC');
    if (!f) return undefined;
    return (f.payload['devices'] as { id: string; available: boolean }[])
      .filter((d) => d.available)
      .map((d) => d.id);
  }
}

const open: VirtualSocket[] = [];

/** One user session on its own hub: a fresh manager + isolated connections. */
function session(opts: PlaybackStateOptions = {}) {
  const manager = new PlaybackStateManager(opts);
  const handlers = createPlaybackHub({ getOrCreate: () => manager }).handlersFor(
    `mdt-user-${++seq}`,
  );
  return {
    manager,
    device(id: string): VirtualSocket {
      const s = new VirtualSocket(handlers, id);
      open.push(s);
      return s;
    },
  };
}

/** Controller + receiver, cast already established. */
function castSession(opts: PlaybackStateOptions = {}) {
  const s = session(opts);
  const controller = s.device('controller');
  const receiver = s.device('receiver');
  controller.register();
  receiver.register();
  controller.send('SET_ACTIVE_DEVICE', { id: 'receiver' });
  controller.send('COMMAND', {
    action: 'SET_TRACK',
    track: { id: 't1', title: 'One', artist: 'A' },
  });
  return { ...s, controller, receiver };
}

function backdate(manager: ReturnType<typeof session>['manager'], id: string, ms: number) {
  if (!manager.markSeen(id, Date.now() - ms)) throw new Error(`${id} not registered`);
}

afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

describe('connection identity across events (#877)', () => {
  it('a heartbeat on a fresh context keeps the device alive', () => {
    const s = session();
    const d = s.device('d1');
    d.register();
    backdate(s.manager, 'd1', 100_000);
    d.send('HEARTBEAT');
    s.manager.cleanupStaleDevices();
    expect(s.manager.getDevices().map((x) => x.id)).toEqual(['d1']);
  });

  it('progress from the active device reaches the controller as STATE_SYNC', () => {
    const { controller, receiver } = castSession();
    const before = controller.frames('STATE_SYNC').length;
    receiver.send('PROGRESS_REPORT', { position: 12.5, duration: 180 });
    const synced = controller.frames('STATE_SYNC').slice(before);
    expect(synced.length).toBe(1);
    expect((synced[0].payload['state'] as { position: number }).position).toBe(12.5);
  });

  it('closing the socket unregisters the device', () => {
    const s = session();
    const a = s.device('a');
    const b = s.device('b');
    a.register();
    b.register();
    b.close();
    expect(s.manager.getDevices().map((x) => x.id)).toEqual(['a']);
    expect(a.lastDeviceIds()).toEqual(['a']);
  });

  it('a close never evicts a device whose id a live connection still holds', () => {
    const s = session();
    const stale = s.device('same-id');
    const live = s.device('same-id');
    stale.register();
    live.register();
    stale.close();
    expect(s.manager.getDevices().map((x) => x.id)).toEqual(['same-id']);
  });
});

describe('liveness', () => {
  it('any message from a registered device is a liveness beat, not only HEARTBEAT', () => {
    const { manager, receiver } = castSession();
    backdate(manager, 'receiver', 100_000);
    receiver.send('PROGRESS_REPORT', { position: 3, duration: 100 });
    manager.cleanupStaleDevices();
    expect(manager.getDevices().map((x) => x.id)).toContain('receiver');
  });

  it('a pruned device is healed by its next message on the same socket (#433)', () => {
    const s = session();
    const d = s.device('d1');
    d.register();
    backdate(s.manager, 'd1', 100_000);
    s.manager.cleanupStaleDevices();
    expect(s.manager.getDevices()).toHaveLength(0);
    d.send('PROGRESS_REPORT', { position: 1, duration: 10 });
    expect(s.manager.getDevices().map((x) => x.id)).toEqual(['d1']);
  });

  it('a heartbeat is acknowledged, so an idle socket is never silent upstream', () => {
    const s = session();
    const d = s.device('d1');
    d.register();
    d.send('HEARTBEAT');
    expect(d.frames('HEARTBEAT_ACK')).toHaveLength(1);
  });
});

describe('opting out while active', () => {
  it('UPDATE_DEVICE remoteEnabled:false releases the active device', () => {
    const { controller, receiver } = castSession();
    receiver.send('UPDATE_DEVICE', { remoteEnabled: false });
    expect(controller.lastActive()).toBeNull();
    // Still listed — the chrome may name it — but no longer a target.
    expect(controller.lastDeviceIds()).toEqual(['controller', 'receiver']);
    expect(controller.lastAvailable()).toEqual(['controller']);
  });

  it('re-registering as not remote-enabled releases the active device', () => {
    const { controller, receiver } = castSession();
    receiver.register({ remoteEnabled: false });
    expect(controller.lastActive()).toBeNull();
    expect(controller.lastAvailable()).toEqual(['controller']);
  });
});

describe('reconnect grace for the active device', () => {
  it('the link survives a reconnect within the grace', async () => {
    const s = castSession({ activeGraceMs: 40 });
    s.receiver.close();
    await Bun.sleep(5);
    const again = s.device('receiver');
    again.register();
    await Bun.sleep(60);
    expect(s.controller.lastActive()).toBe('receiver');
    expect(again.lastActive()).toBe('receiver');
    expect(s.manager.getState().activeDeviceId).toBe('receiver');
  });

  it('the active device stays listed during the grace', () => {
    const s = castSession({ activeGraceMs: 40 });
    s.receiver.close();
    expect(s.controller.lastActive()).toBe('receiver');
    expect(s.manager.getDevices().map((x) => x.id)).toContain('receiver');
  });

  it('the active device is released once the grace expires', async () => {
    const s = castSession({ activeGraceMs: 20 });
    s.receiver.close();
    await Bun.sleep(40);
    expect(s.controller.lastActive()).toBeNull();
    expect(s.controller.lastDeviceIds()).toEqual(['controller']);
  });

  it('a stale prune of the active device honours the same grace', async () => {
    const s = castSession({ activeGraceMs: 20 });
    backdate(s.manager, 'receiver', 100_000);
    s.manager.cleanupStaleDevices();
    expect(s.controller.lastActive()).toBe('receiver');
    await Bun.sleep(40);
    expect(s.controller.lastActive()).toBeNull();
  });

  it('a non-active device is dropped immediately, no grace', () => {
    const s = castSession({ activeGraceMs: 10_000 });
    s.controller.close();
    expect(s.manager.getDevices().map((x) => x.id)).toEqual(['receiver']);
  });

  it('handing the session to another device during the grace cancels the release', async () => {
    const s = castSession({ activeGraceMs: 20 });
    s.receiver.close();
    s.controller.send('SET_ACTIVE_DEVICE', { id: 'controller' });
    await Bun.sleep(40);
    expect(s.controller.lastActive()).toBe('controller');
    expect(s.manager.getState().activeDeviceId).toBe('controller');
  });
});

describe('claim-on-play (no picker)', () => {
  const t = { id: 't1', title: 'One', artist: 'A' };
  const claim = (d: VirtualSocket, id = 't1') =>
    d.send('CLAIM_OUTPUT', { track: { ...t, id }, trackId: id, position: 0, isPlaying: true });

  it('the first device to play becomes the output in one broadcast that carries its track', () => {
    const s = session();
    const a = s.device('a');
    const b = s.device('b');
    a.register();
    b.register();
    claim(a);
    const f = b.last('STATE_SYNC')!.payload['state'] as { activeDeviceId: string; trackId: string };
    expect(f.activeDeviceId).toBe('a');
    expect(f.trackId).toBe('t1');
    expect(b.frames('STATE_SYNC')).toHaveLength(2); // its own snapshot + the claim
  });

  it('a second claim against a live output loses and is answered privately with the truth', () => {
    const s = session();
    const a = s.device('a');
    const b = s.device('b');
    a.register();
    b.register();
    claim(a);
    const before = a.frames('STATE_SYNC').length;
    claim(b, 't2');
    expect(s.manager.getState().activeDeviceId).toBe('a');
    expect(a.frames('STATE_SYNC')).toHaveLength(before); // nobody else heard it
    const reply = b.last('STATE_SYNC')!;
    expect((reply.payload['state'] as { activeDeviceId: string }).activeDeviceId).toBe('a');
    expect(reply.payload['devices']).toBeDefined();
  });

  it('RELEASE_OUTPUT from the output frees the session at once; a bystander cannot', () => {
    const s = session({ activeGraceMs: 10_000 });
    const a = s.device('a');
    const b = s.device('b');
    a.register();
    b.register();
    claim(a);
    b.send('RELEASE_OUTPUT');
    expect(s.manager.getState().activeDeviceId).toBe('a');
    a.send('RELEASE_OUTPUT');
    expect(b.lastActive()).toBeNull();
    claim(b);
    expect(s.manager.getState().activeDeviceId).toBe('b');
  });

  it('SET_ACTIVE_DEVICE to an opted-out or unknown device is ignored', () => {
    const s = session();
    const a = s.device('a');
    const b = s.device('b');
    a.register();
    b.register({ remoteEnabled: false });
    a.send('SET_ACTIVE_DEVICE', { id: 'b' });
    a.send('SET_ACTIVE_DEVICE', { id: 'ghost' });
    expect(s.manager.getState().activeDeviceId).toBeNull();
  });

  it('an opted-out device is listed as unavailable, not hidden', () => {
    const s = session();
    const a = s.device('a');
    const b = s.device('b');
    a.register();
    b.register({ remoteEnabled: false });
    const list = a.last('DEVICES_SYNC')!.payload['devices'] as { id: string; available: boolean }[];
    expect(list.map((d) => [d.id, d.available])).toEqual([
      ['a', true],
      ['b', false],
    ]);
  });

  it("the output's pause report reaches the controller as a broadcast", () => {
    const s = session();
    const a = s.device('a');
    const b = s.device('b');
    a.register();
    b.register();
    claim(a);
    a.send('STATE_UPDATE', { state: { isPlaying: false, position: 7 } });
    const f = b.last('STATE_SYNC')!.payload['state'] as { isPlaying: boolean; position: number };
    expect(f.isPlaying).toBe(false);
    expect(f.position).toBe(7);
  });

  it("a controller's STATE_UPDATE never overwrites the output's state", () => {
    const s = session();
    const a = s.device('a');
    const b = s.device('b');
    a.register();
    b.register();
    claim(a);
    b.send('STATE_UPDATE', { state: { isPlaying: false, position: 99 } });
    expect(s.manager.getState().isPlaying).toBe(true);
  });
});

import { describe, expect, it } from 'bun:test';
import type { WSContext } from 'hono/ws';
import {
  castTo,
  hasControllableSession,
  initialRemoteClientState,
  isAudioOutput,
  onLocalPlayingChanged,
  onLocalQueueChanged,
  onLocalTrackChanged,
  reduceServerMessage,
  type ClientMessage,
  type PlayerEffect,
  type RemoteClientContext,
  type RemoteClientState,
  type RemoteTrack,
  type ServerMessage,
} from '@nicotind/core';
import { createPlaybackHub } from './websocket.js';
import { PlaybackStateManager, type PlaybackStateOptions } from './playback-state.js';

/**
 * Virtual multi-device simulation (issue #877).
 *
 * N devices share one user session on the REAL server (`PlaybackStateManager`
 * + the hub handlers) and each runs the REAL client decisions (`@nicotind/core`
 * `reduceServerMessage` / `castTo` / `onLocalTrackChanged`, the same functions
 * `RemotePlaybackService` applies to `PlayerService`) over a virtual player.
 * Only the transport and the `<audio>` element are virtual: frames are
 * delivered synchronously through a fresh WSContext per event, like Hono's Bun
 * adapter.
 *
 * The invariant every scenario checks: while a session exists, at most ONE
 * device is audible, and it is the one the server calls active. The three
 * user-visible symptoms behind #877 were all violations of it. Since a device
 * claims the session the moment it plays, a session exists whenever anything
 * plays — so the invariant now says: at most one device is ever audible.
 *
 * And, since #895, a second one: the session has ONE queue. Every online
 * device in a session holds the queue the server holds, so the list a
 * controller renders is the list the output will play.
 */

type Frame = { type: string; payload: Record<string, unknown> };
type Handlers = ReturnType<ReturnType<typeof createPlaybackHub>['handlersFor']>;

const T1: RemoteTrack = { id: 't1', title: 'One', artist: 'A', duration: 200 };
const T2: RemoteTrack = { id: 't2', title: 'Two', artist: 'A', duration: 200 };
const T3: RemoteTrack = { id: 't3', title: 'Three', artist: 'A', duration: 200 };
const T4: RemoteTrack = { id: 't4', title: 'Four', artist: 'A', duration: 200 };
const T5: RemoteTrack = { id: 't5', title: 'Five', artist: 'A', duration: 200 };
/** The shared library every device resolves queue ids against. */
const LIBRARY = new Map([T1, T2, T3, T4, T5].map((t) => [t.id, t]));
const ids = (q: RemoteTrack[]) => q.map((t) => t.id);

class VirtualDevice {
  // The virtual player — what `PlayerService` + the <audio> element hold.
  track: RemoteTrack | null = null;
  playing = false;
  position = 0;
  queue: RemoteTrack[] = [];
  history: RemoteTrack[] = [];
  /** Ids this device cannot resolve to a playable track. */
  readonly unresolvable = new Set<string>();
  remoteEnabled = true;
  client: RemoteClientState = initialRemoteClientState();
  online = false;
  readonly received: Frame[] = [];

  private raw: object = {};
  private previousTrackId: string | null = null;
  private previousPlaying = false;
  private previousQueue: string[] = [];
  /** `queue.set(...)` notifies even when the ids did not change. */
  private queueSet = false;

  constructor(
    private readonly handlers: Handlers,
    readonly id: string,
  ) {}

  /** This device plays audio: it is the output and its player is playing. */
  get audible(): boolean {
    return isAudioOutput(this.client.activeDeviceId, this.id) && this.playing;
  }

  // --- transport -----------------------------------------------------------

  private wsCtx(): WSContext {
    return {
      raw: this.raw,
      send: (data: string) => this.onFrame(JSON.parse(data) as Frame),
    } as unknown as WSContext;
  }

  send(type: string, payload: Record<string, unknown> = {}): void {
    if (!this.online) return;
    this.handlers.onMessage!(
      { data: JSON.stringify({ type, payload }) } as MessageEvent,
      this.wsCtx(),
    );
  }

  connect(): void {
    this.online = true;
    this.raw = {}; // a new socket
    this.send('REGISTER', {
      id: this.id,
      name: this.id,
      deviceType: 'web',
      remoteEnabled: this.remoteEnabled,
      activated: true,
      compactProgress: true,
    });
  }

  /** The socket drops (Wi-Fi blip, tab killed). The player keeps going. */
  disconnect(): void {
    if (!this.online) return;
    this.online = false;
    this.handlers.onClose!({} as CloseEvent, this.wsCtx());
  }

  private onFrame(frame: Frame): void {
    this.received.push(frame);
    if (frame.type === 'HEARTBEAT_ACK') return;
    const r = reduceServerMessage(this.client, this.ctx(), frame as ServerMessage);
    this.client = r.state;
    this.applyEffects(r.effects);
  }

  // --- the client adapter, mirroring RemotePlaybackService -----------------

  private ctx(): RemoteClientContext {
    return {
      myId: this.id,
      remoteEnabled: this.remoteEnabled,
      localTrackId: this.track?.id ?? null,
      localQueue: ids(this.queue),
      now: Date.now(),
    };
  }

  private applyEffects(effects: PlayerEffect[]): void {
    for (const e of effects) {
      switch (e.kind) {
        case 'play':
          this.track = e.track;
          this.playing = true;
          this.position = 0;
          break;
        case 'resume':
          this.playing = true;
          break;
        case 'pause':
        case 'yield':
          this.playing = false;
          break;
        case 'seek':
          this.position = e.position;
          break;
        case 'show-track':
          this.track = e.track;
          break;
        case 'resume-local':
          this.position = e.position;
          this.playing = e.playing;
          break;
        case 'next':
          this.playNext();
          break;
        case 'prev':
          if (this.history.length > 0) {
            if (this.track) this.queue = [this.track, ...this.queue];
            this.track = this.history.pop()!;
            this.playing = true;
            this.position = 0;
          }
          break;
        case 'set-queue':
          // The adapter's resolution: ids this device cannot play are dropped.
          this.queue = e.ids
            .filter((id) => !this.unresolvable.has(id))
            .map((id) => LIBRARY.get(id))
            .filter((t): t is RemoteTrack => t !== undefined);
          this.queueSet = true;
          break;
      }
    }
    // The queue effect is registered first in `RemotePlaybackService`, so an
    // edit that also moves the track (a jump, an album pick) reaches the
    // server before the track does.
    this.queueChanged();
    this.playingChanged();
    this.trackChanged();
  }

  /** `PlayerService.playNext`: consume the queue, or stop at its end. */
  private playNext(): void {
    const [next, ...rest] = this.queue;
    if (!next) {
      this.playing = false;
      return;
    }
    if (this.track) this.history.push(this.track);
    this.track = next;
    this.queue = rest;
    this.playing = true;
    this.position = 0;
  }

  /** The `queue` effect: fires once per change of the id list. */
  private queueChanged(): void {
    const now = ids(this.queue);
    const same =
      now.length === this.previousQueue.length &&
      now.every((id, i) => id === this.previousQueue[i]);
    if (same && !this.queueSet) return;
    this.queueSet = false;
    this.previousQueue = now;
    const r = onLocalQueueChanged(this.client, this.ctx(), now);
    this.client = r.state; // before posting: delivery is synchronous here
    this.post(r.messages);
  }

  /** The `isPlaying` effect: the output reports it, a device with no
   *  controllable session claims when it starts. */
  private playingChanged(): void {
    if (this.playing === this.previousPlaying) return;
    this.previousPlaying = this.playing;
    this.post(
      onLocalPlayingChanged(this.client, this.ctx(), this.playing, this.track, this.position)
        .messages,
    );
  }

  /** The `currentTrack` effect: fires once per track-id change. */
  private trackChanged(): void {
    const id = this.track?.id ?? null;
    if (id === this.previousTrackId) return;
    this.previousTrackId = id;
    if (!this.track) return;
    this.post(onLocalTrackChanged(this.client, this.ctx(), this.track).messages);
  }

  private post(messages: ClientMessage[]): void {
    for (const m of messages) this.send(m.type, m.payload as Record<string, unknown>);
  }

  // --- user actions --------------------------------------------------------

  /** A pick in the library: `player.play(track)` sets the track and
   *  `isPlaying` together. */
  playLocally(track: RemoteTrack): void {
    this.track = track;
    this.playing = true;
    this.position = 0;
    this.playingChanged();
    this.trackChanged();
  }

  /** An album pick: play the first track, queue the rest. */
  playAll(tracks: RemoteTrack[]): void {
    const [first, ...rest] = tracks;
    this.queue = rest;
    this.history = [];
    this.queueChanged();
    this.playLocally(first!);
  }

  /** A queue gesture in the panel (remove, move, clear, add next/later). */
  editQueue(edit: (q: RemoteTrack[]) => RemoteTrack[]): void {
    this.queue = edit([...this.queue]);
    this.queueChanged();
  }

  /** `jumpToQueueIndex`: play queue[i], consuming everything before it. */
  jumpTo(index: number): void {
    const target = this.queue[index]!;
    if (this.track) this.history.push(this.track);
    this.history.push(...this.queue.slice(0, index));
    this.queue = this.queue.slice(index + 1);
    this.queueChanged();
    this.playLocally(target);
  }

  /** The Next button: local on the output, a command on a controller. */
  pressNext(): void {
    if (isAudioOutput(this.client.activeDeviceId, this.id)) this.applyEffects([{ kind: 'next' }]);
    else this.send('COMMAND', { action: 'NEXT' });
  }

  /** The output's `<audio>` fired `ended`. */
  trackEnds(): void {
    if (isAudioOutput(this.client.activeDeviceId, this.id) && this.playing) {
      this.applyEffects([{ kind: 'next' }]);
    }
  }

  cast(targetId: string): void {
    const r = castTo(this.client, this.ctx(), targetId, this.track);
    this.post(r.messages);
    this.client = r.state;
    this.applyEffects(r.effects);
  }

  /** The Settings toggle: the web client sends UPDATE_DEVICE; the socket
   *  stays up either way (it is the account's presence channel). */
  setRemoteEnabled(on: boolean): void {
    this.remoteEnabled = on;
    this.send('UPDATE_DEVICE', { remoteEnabled: on });
  }

  /** The tab closes: `pagehide` releases the output before the socket dies. */
  closeTab(): void {
    if (this.client.activeDeviceId === this.id) this.send('RELEASE_OUTPUT');
    this.disconnect();
    this.playing = false; // the tab is gone; so is its <audio>
  }

  /** `handlePlayPause` on the player bar: local on the output, a command on a
   *  controller, a claim when the session's device cannot be driven. */
  pressPlayPause(): void {
    if (isAudioOutput(this.client.activeDeviceId, this.id)) {
      this.playing = !this.playing;
      this.playingChanged();
    } else if (!hasControllableSession(this.client)) {
      this.playing = true;
      this.playingChanged();
    } else {
      this.send('COMMAND', { action: this.client.remoteIsPlaying ? 'PAUSE' : 'PLAY' });
    }
  }

  /** `onSeek` on the seek bar. */
  seekTo(position: number): void {
    if (isAudioOutput(this.client.activeDeviceId, this.id)) this.position = position;
    else this.send('COMMAND', { action: 'SEEK', position });
  }

  /** The 2s progress interval on the output device. */
  reportProgress(): void {
    if (isAudioOutput(this.client.activeDeviceId, this.id) && this.playing) {
      this.send('PROGRESS_REPORT', {
        position: this.position,
        duration: this.track?.duration ?? 0,
      });
    }
  }

  advance(seconds: number): void {
    if (this.playing) this.position += seconds;
  }
}

function world(opts: PlaybackStateOptions = {}) {
  const manager = new PlaybackStateManager(opts);
  const handlers = createPlaybackHub({ getOrCreate: () => manager }).handlersFor('sim-user');
  const devices: VirtualDevice[] = [];
  return {
    manager,
    device(id: string): VirtualDevice {
      const d = new VirtualDevice(handlers, id);
      d.connect();
      devices.push(d);
      return d;
    },
    audible: () => devices.filter((d) => d.audible).map((d) => d.id),
    /** Every device's belief about who the output is. */
    views: () => devices.map((d) => `${d.id}:${d.client.activeDeviceId}`),
    listedOn: (d: VirtualDevice) => d.client.devices.map((x) => x.id),
    /** What the picker on `d` offers. */
    offeredOn: (d: VirtualDevice) =>
      d.client.devices.filter((x) => x.available !== false).map((x) => x.id),
    /** The session has one queue: every online device holds the server's. */
    assertOneQueue() {
      const state = manager.getState();
      if (state.activeDeviceId === null) return;
      for (const d of devices.filter((x) => x.online)) {
        expect({ id: d.id, queue: ids(d.queue) }).toEqual({ id: d.id, queue: state.queue });
      }
    },
    /** Holds whenever a session exists. */
    assertOneOutput() {
      const active = manager.getState().activeDeviceId;
      if (active === null) return;
      const audible = devices.filter((d) => d.online && d.audible).map((d) => d.id);
      expect(audible.length).toBeLessThanOrEqual(1);
      for (const id of audible) expect(id).toBe(active);
      this.assertOneQueue();
    },
  };
}

/** Controller A playing T1 locally, B and the rest idle, A casts to B. */
function castWorld(opts: PlaybackStateOptions = {}) {
  const w = world(opts);
  const a = w.device('A');
  const b = w.device('B');
  a.playLocally(T1);
  a.cast('B');
  return { ...w, a, b };
}

describe('simulation: cast', () => {
  it('exactly one device is audible and it is the receiver', () => {
    const w = castWorld();
    expect(w.audible()).toEqual(['B']);
    expect(w.b.track).toEqual(T1);
    expect(w.views()).toEqual(['A:B', 'B:B']);
    w.assertOneOutput();
  });

  it('the controller mirrors the receiver without playing', () => {
    const w = castWorld();
    expect(w.a.track).toEqual(T1);
    expect(w.a.playing).toBe(false);
  });

  it("the receiver's progress reaches the controller", () => {
    const w = castWorld();
    w.b.advance(10);
    w.b.reportProgress();
    expect(w.a.client.remotePosition).toBe(10);
    expect(w.a.client.remoteIsPlaying).toBe(true);
  });

  it('pause and play round-trip from the controller', () => {
    const w = castWorld();
    w.a.pressPlayPause();
    expect(w.b.playing).toBe(false);
    expect(w.a.client.remoteIsPlaying).toBe(false);
    w.a.pressPlayPause();
    expect(w.b.playing).toBe(true);
    expect(w.audible()).toEqual(['B']);
  });

  it('a seek from the controller lands on the receiver', () => {
    const w = castWorld();
    w.a.seekTo(50);
    expect(w.b.position).toBe(50);
  });

  it('a track picked on the controller plays on the receiver', () => {
    const w = castWorld();
    w.a.playLocally(T2);
    expect(w.b.track).toEqual(T2);
    expect(w.audible()).toEqual(['B']);
    w.assertOneOutput();
  });

  it('a third device that was playing is the output; a pick elsewhere goes to it, a cast moves it', () => {
    const w = world();
    const a = w.device('A');
    w.device('B');
    const c = w.device('C');
    c.playLocally(T3);
    expect(w.audible()).toEqual(['C']);
    a.playLocally(T1); // a pick on a controller plays on the output
    expect(w.audible()).toEqual(['C']);
    expect(c.track).toEqual(T1);
    a.cast('B');
    expect(w.audible()).toEqual(['B']);
    expect(w.views()).toEqual(['A:B', 'B:B', 'C:B']);
    w.assertOneOutput();
  });
});

describe('simulation: the receiver opts out (symptom 3)', () => {
  it('releases the controller, which does not start playing on its own', () => {
    const w = castWorld();
    w.b.setRemoteEnabled(false);
    expect(w.a.client.activeDeviceId).toBeNull();
    expect(w.a.playing).toBe(false);
    expect(w.listedOn(w.a)).toEqual(['A', 'B']);
    expect(w.offeredOn(w.a)).toEqual(['A']);
    w.assertOneOutput();
  });

  it('after opting back in, a fresh cast plays the current track on both sides', () => {
    const w = castWorld();
    w.b.setRemoteEnabled(false);
    w.a.playLocally(T2); // the controller moved on while B was out
    w.b.setRemoteEnabled(true);
    expect(w.listedOn(w.a)).toContain('B');
    w.a.cast('B');
    expect(w.b.track).toEqual(T2);
    expect(w.a.track).toEqual(T2);
    w.a.seekTo(30);
    expect(w.b.position).toBe(30);
    expect(w.audible()).toEqual(['B']);
  });
});

describe('simulation: the receiver loses its socket (symptom 1)', () => {
  it('a reconnect within the grace keeps the session when nobody acted meanwhile', async () => {
    const w = castWorld({ activeGraceMs: 200 });
    w.b.disconnect();
    await Bun.sleep(20);
    w.b.connect();
    expect(w.views()).toEqual(['A:B', 'B:B']);
    expect(w.a.audible).toBe(false);
    expect(w.audible()).toEqual(['B']);
  });

  it("a pick during the receiver's blip plays here; the receiver finds the session moved", async () => {
    // The controller cannot tell a 1 s blip from a crashed tab, and a play
    // that does nothing for 15 s is the worse outcome: the device the user
    // acted on plays.
    const w = castWorld({ activeGraceMs: 200 });
    w.b.disconnect();
    w.a.playLocally(T2);
    expect(w.a.audible).toBe(true); // B, offline, still plays until it hears otherwise
    await Bun.sleep(20);
    w.b.connect();
    expect(w.views()).toEqual(['A:A', 'B:A']);
    expect(w.b.playing).toBe(false);
    expect(w.audible()).toEqual(['A']);
    w.assertOneOutput();
  });

  it('gone for good after the controller picked a new track: the pick made the controller the output', async () => {
    // The pick during the grace claimed the output (the receiver was pending),
    // so the receiver's final release is about a session that already moved:
    // nothing ends, nothing wakes, A just keeps playing what the user picked.
    const w = castWorld({ activeGraceMs: 20 });
    w.b.disconnect();
    w.a.playLocally(T2);
    await Bun.sleep(40);
    expect(w.a.client.activeDeviceId).toBe('A');
    expect(w.a.audible).toBe(true);
    expect(w.listedOn(w.a)).toEqual(['A']);
  });

  it('a reconnect that finds the session paused comes back paused at the position', async () => {
    const w = castWorld({ activeGraceMs: 200 });
    w.b.advance(15);
    w.b.reportProgress();
    w.a.pressPlayPause(); // PAUSE
    w.b.disconnect();
    w.b.track = null; // e.g. the tab reloaded
    w.b.connect();
    // `expect<…>`: the assignment above narrows the field to `null` for tsc.
    expect<RemoteTrack | null>(w.b.track).toEqual(T1);
    expect(w.b.playing).toBe(false);
    expect(w.b.position).toBe(15);
  });

  it('gone for good: the session ends and no other device wakes up', async () => {
    const w = castWorld({ activeGraceMs: 20 });
    w.b.disconnect();
    expect(w.a.client.activeDeviceId).toBe('B'); // still linked during the grace
    await Bun.sleep(40);
    expect(w.a.client.activeDeviceId).toBeNull();
    expect(w.a.playing).toBe(false);
    expect(w.listedOn(w.a)).toEqual(['A']);
  });

  it('a receiver that only reports progress is never pruned as stale', () => {
    const w = castWorld();
    for (let round = 0; round < 5; round++) {
      w.manager.markSeen('B', Date.now() - 100_000);
      w.b.advance(2);
      w.b.reportProgress();
      w.manager.cleanupStaleDevices();
    }
    expect(w.manager.getDevices().map((d) => d.id)).toContain('B');
    expect(w.views()).toEqual(['A:B', 'B:B']);
  });

  it('the controller losing its own socket changes nothing for the receiver', () => {
    const w = castWorld({ activeGraceMs: 10_000 });
    w.a.disconnect();
    w.b.advance(3);
    w.b.reportProgress();
    expect(w.audible()).toEqual(['B']);
    w.a.connect();
    expect(w.a.client.activeDeviceId).toBe('B');
    expect(w.a.track).toEqual(T1);
    expect(w.a.playing).toBe(false);
  });
});

describe('simulation: taking the session back', () => {
  it('the controller resumes where the receiver was and the receiver goes quiet', () => {
    const w = castWorld();
    w.b.advance(20);
    w.b.reportProgress();
    w.a.cast('A');
    expect(w.audible()).toEqual(['A']);
    expect(w.a.position).toBeGreaterThanOrEqual(20);
    expect(w.b.playing).toBe(false);
    expect(w.views()).toEqual(['A:A', 'B:A']);
    w.assertOneOutput();
  });

  it('handing the session on to a third device silences the second', () => {
    const w = world();
    const a = w.device('A');
    const b = w.device('B');
    const c = w.device('C');
    a.playLocally(T1);
    a.cast('B');
    a.cast('C');
    expect(w.audible()).toEqual(['C']);
    expect(b.playing).toBe(false);
    expect(c.track).toEqual(T1);
    expect(w.views()).toEqual(['A:C', 'B:C', 'C:C']);
  });
});

describe('simulation: two tabs of one browser profile (issue #882)', () => {
  /** Model A: the id is minted per TAB, so a second tab of the same profile
   *  registers a sibling id (`<profile>:<tab>`) over its own socket. */
  function twoTabWorld() {
    const w = world();
    const a = w.device('A');
    const tab1 = w.device('B:t1');
    const tab2 = w.device('B:t2');
    a.playLocally(T1);
    a.cast('B:t1');
    return { ...w, a, tab1, tab2 };
  }

  it('a cast to one tab plays there and leaves the sibling silent', () => {
    const w = twoTabWorld();
    expect(w.audible()).toEqual(['B:t1']);
    expect(w.tab2.playing).toBe(false);
    w.assertOneOutput();
  });

  it('closing the silent tab does not unregister the one holding the session', () => {
    const w = twoTabWorld();
    w.tab2.disconnect();
    expect(w.listedOn(w.a)).toContain('B:t1');
    expect(w.audible()).toEqual(['B:t1']);
  });

  it('each tab is separately castable', () => {
    const w = twoTabWorld();
    w.a.cast('B:t2');
    expect(w.audible()).toEqual(['B:t2']);
    w.assertOneOutput();
  });
});

describe('simulation: claim-on-play — no picker involved', () => {
  it('the first device to play becomes the output; a pick on another device plays there', () => {
    const w = world();
    const a = w.device('A');
    const b = w.device('B');
    a.playLocally(T1);
    expect(w.audible()).toEqual(['A']);
    expect(w.views()).toEqual(['A:A', 'B:A']);
    b.playLocally(T2);
    expect(w.audible()).toEqual(['A']);
    expect(a.track).toEqual(T2);
    expect(b.track).toEqual(T2);
    expect(b.audible).toBe(false); // it was never the output; it mirrors
    w.assertOneOutput();
  });

  it("the output's own pause reaches the controller, whose button then says play", () => {
    const w = world();
    const a = w.device('A');
    const b = w.device('B');
    a.playLocally(T1);
    a.pressPlayPause();
    expect(a.playing).toBe(false);
    expect(b.client.remoteIsPlaying).toBe(false);
    b.pressPlayPause(); // PLAY, not a second PAUSE
    expect(a.playing).toBe(true);
    expect(w.audible()).toEqual(['A']);
  });

  it('closing the output tab frees the session at once; the next play elsewhere claims', () => {
    const w = world({ activeGraceMs: 10_000 });
    const a = w.device('A');
    const b = w.device('B');
    a.playLocally(T1);
    a.closeTab();
    expect(b.client.activeDeviceId).toBeNull();
    b.playLocally(T2);
    expect(w.audible()).toEqual(['B']);
    expect(w.manager.getState().activeDeviceId).toBe('B');
  });

  it('an opted-out device that plays still claims; a pick elsewhere cannot drive it, so it claims back', () => {
    const w = world();
    const a = w.device('A');
    const b = w.device('B');
    a.setRemoteEnabled(false);
    a.playLocally(T1);
    expect(w.audible()).toEqual(['A']);
    expect(w.views()).toEqual(['A:A', 'B:A']);
    expect(w.offeredOn(b)).toEqual(['B']);
    b.playLocally(T2);
    expect(w.audible()).toEqual(['B']);
    expect(a.playing).toBe(false);
    expect(w.views()).toEqual(['A:B', 'B:B']);
    w.assertOneOutput();
  });

  it('a controller whose output cannot be driven claims on play too', () => {
    const w = world();
    const a = w.device('A');
    const b = w.device('B');
    a.setRemoteEnabled(false);
    a.playLocally(T1);
    b.track = T2; // something restored locally, paused
    b.pressPlayPause();
    expect(w.audible()).toEqual(['B']);
  });

  it('a paused output left alone releases the session; the next play elsewhere claims', async () => {
    const w = world({ idleReleaseMs: 20 });
    const a = w.device('A');
    const b = w.device('B');
    a.playLocally(T1);
    a.pressPlayPause();
    await Bun.sleep(30);
    w.manager.cleanupStaleDevices();
    expect(b.client.activeDeviceId).toBeNull();
    expect(a.playing).toBe(false);
    b.playLocally(T2);
    expect(w.audible()).toEqual(['B']);
    expect(w.views()).toEqual(['A:B', 'B:B']);
  });

  it('a crashed output (no pagehide) does not swallow a play elsewhere for the grace', async () => {
    const w = world({ activeGraceMs: 10_000 });
    const a = w.device('A');
    const b = w.device('B');
    b.playLocally(T1);
    b.disconnect(); // killed, no RELEASE_OUTPUT
    a.playLocally(T2);
    expect(a.audible).toBe(true);
    expect(w.manager.getState().activeDeviceId).toBe('A');
    w.assertOneOutput();
  });
});

describe('simulation: the session has one queue (#895)', () => {
  /** A plays an album locally (claims), then casts to an idle B that had
   *  its own, unrelated queue. */
  function albumCast() {
    const w = world();
    const a = w.device('A');
    const b = w.device('B');
    b.queue = [T5]; // B's own prior local queue
    a.playAll([T1, T2, T3, T4]);
    a.cast('B');
    return { ...w, a, b };
  }

  it("the cast hands the controller's queue to the output, which replaces its own", () => {
    const w = albumCast();
    expect(w.b.track).toEqual(T1);
    expect(ids(w.b.queue)).toEqual(['t2', 't3', 't4']);
    expect(ids(w.a.queue)).toEqual(['t2', 't3', 't4']);
    w.assertOneQueue();
    w.assertOneOutput();
  });

  it('the cast queue wins even when the server held a stale queue from an earlier session', () => {
    const w = world();
    const a = w.device('A');
    const b = w.device('B');
    a.playAll([T5, T4]);
    a.pressPlayPause(); // A stays the (paused) output with queue [t4]
    a.editQueue(() => [T2, T3]);
    a.cast('B');
    expect(ids(b.queue)).toEqual(['t2', 't3']);
    expect(ids(a.queue)).toEqual(['t2', 't3']);
    w.assertOneQueue();
  });

  it('when the track ends the output advances along the session queue and the controller follows', () => {
    const w = albumCast();
    w.b.trackEnds();
    expect(w.b.track).toEqual(T2);
    expect(w.a.track).toEqual(T2);
    expect(ids(w.a.queue)).toEqual(['t3', 't4']);
    w.assertOneQueue();
    w.assertOneOutput();
  });

  it('Next on the controller consumes the session queue on the output', () => {
    const w = albumCast();
    w.a.pressNext();
    expect(w.b.track).toEqual(T2);
    expect(ids(w.a.queue)).toEqual(['t3', 't4']);
    w.assertOneQueue();
  });

  it('controller edits take effect on what plays: remove, move, add next, add later', () => {
    const w = albumCast();
    w.a.editQueue((q) => q.filter((t) => t.id !== 't2')); // remove
    w.assertOneQueue();
    w.a.editQueue(([x, y]) => [y!, x!]); // move
    expect(ids(w.b.queue)).toEqual(['t4', 't3']);
    w.a.editQueue((q) => [T5, ...q]); // play next
    w.a.editQueue((q) => [...q, T2]); // add to queue
    expect(ids(w.b.queue)).toEqual(['t5', 't4', 't3', 't2']);
    w.assertOneQueue();
    w.b.trackEnds();
    expect(w.b.track).toEqual(T5); // the edit decided what played next
    w.assertOneQueue();
  });

  it('clear on the controller empties the queue; the output stops at the end of its track', () => {
    const w = albumCast();
    w.a.editQueue(() => []);
    expect(w.b.queue).toEqual([]);
    w.b.trackEnds();
    expect(w.b.playing).toBe(false);
    expect(w.b.track).toEqual(T1);
    w.assertOneQueue();
  });

  it('a jump on the controller plays that track on the output and drops what it skipped', () => {
    const w = albumCast();
    w.a.jumpTo(1); // t3
    expect(w.b.track).toEqual(T3);
    expect(ids(w.b.queue)).toEqual(['t4']);
    expect(w.audible()).toEqual(['B']);
    w.assertOneQueue();
  });

  it('an id the output cannot resolve is skipped, and the controller sees it gone', () => {
    const w = albumCast();
    w.b.unresolvable.add('t5');
    w.a.editQueue((q) => [T5, ...q]);
    expect(ids(w.b.queue)).toEqual(['t2', 't3', 't4']);
    expect(ids(w.a.queue)).toEqual(['t2', 't3', 't4']);
    w.assertOneQueue();
  });

  it('a third device mirrors the same queue', () => {
    const w = albumCast();
    const c = w.device('C');
    expect(ids(c.queue)).toEqual(['t2', 't3', 't4']);
    w.a.editQueue((q) => q.slice(1));
    expect(ids(c.queue)).toEqual(['t3', 't4']);
    w.assertOneQueue();
  });

  it('the controller disconnecting leaves the output playing the session queue it has', () => {
    const w = albumCast();
    w.a.disconnect();
    w.b.trackEnds();
    w.b.trackEnds();
    expect(w.b.track).toEqual(T3);
    expect(ids(w.b.queue)).toEqual(['t4']);
    w.a.connect(); // the snapshot reply brings it up to date
    expect(w.a.track).toEqual(T3);
    expect(ids(w.a.queue)).toEqual(['t4']);
    w.assertOneQueue();
  });

  it('an edit made during the output reconnect blip reaches it on reconnect', () => {
    const w = castWorld({ activeGraceMs: 10_000 });
    w.a.editQueue(() => [T2, T3]);
    w.b.disconnect();
    w.a.editQueue((q) => [...q, T5]); // B is pending: the server keeps the edit
    expect(ids(w.b.queue)).toEqual(['t2', 't3']);
    w.b.connect();
    expect(ids(w.b.queue)).toEqual(['t2', 't3', 't5']);
    w.assertOneQueue();
  });

  it('taking the session back continues along the same queue locally', () => {
    const w = albumCast();
    w.b.trackEnds();
    w.a.cast('A');
    expect(w.audible()).toEqual(['A']);
    w.a.trackEnds();
    expect(w.a.track).toEqual(T3);
    expect(ids(w.b.queue)).toEqual(['t4']);
    w.assertOneQueue();
    w.assertOneOutput();
  });
});

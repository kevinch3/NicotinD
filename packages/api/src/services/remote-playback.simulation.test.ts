import { describe, expect, it } from 'bun:test';
import type { WSContext } from 'hono/ws';
import {
  castTo,
  hasControllableSession,
  initialRemoteClientState,
  isAudioOutput,
  onLocalPlayingChanged,
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
 */

type Frame = { type: string; payload: Record<string, unknown> };
type Handlers = ReturnType<ReturnType<typeof createPlaybackHub>['handlersFor']>;

const T1: RemoteTrack = { id: 't1', title: 'One', artist: 'A', duration: 200 };
const T2: RemoteTrack = { id: 't2', title: 'Two', artist: 'A', duration: 200 };
const T3: RemoteTrack = { id: 't3', title: 'Three', artist: 'A', duration: 200 };

class VirtualDevice {
  // The virtual player — what `PlayerService` + the <audio> element hold.
  track: RemoteTrack | null = null;
  playing = false;
  position = 0;
  remoteEnabled = true;
  client: RemoteClientState = initialRemoteClientState();
  online = false;
  readonly received: Frame[] = [];

  private raw: object = {};
  private previousTrackId: string | null = null;
  private previousPlaying = false;

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
        case 'prev':
          break; // no queue in the simulation
      }
    }
    this.playingChanged();
    this.trackChanged();
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
    /** Holds whenever a session exists. */
    assertOneOutput() {
      const active = manager.getState().activeDeviceId;
      if (active === null) return;
      const audible = devices.filter((d) => d.online && d.audible).map((d) => d.id);
      expect(audible.length).toBeLessThanOrEqual(1);
      for (const id of audible) expect(id).toBe(active);
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
  it('a reconnect within the grace keeps the session and re-syncs the track', async () => {
    const w = castWorld({ activeGraceMs: 200 });
    w.b.disconnect();
    w.a.playLocally(T2); // broadcast reaches nobody who is offline
    await Bun.sleep(20);
    w.b.connect();
    expect(w.b.track).toEqual(T2);
    expect(w.views()).toEqual(['A:B', 'B:B']);
    expect(w.a.audible).toBe(false);
    expect(w.audible()).toEqual(['B']);
  });

  it('gone for good after the controller picked a new track: the controller stays silent', async () => {
    // Picking a track re-arms the local player (`play()` sets isPlaying), so
    // the yield at cast time is not enough — the session ending must pause.
    const w = castWorld({ activeGraceMs: 20 });
    w.b.disconnect();
    w.a.playLocally(T2);
    await Bun.sleep(40);
    expect(w.a.client.activeDeviceId).toBeNull();
    expect(w.a.audible).toBe(false);
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

  it('a controller picking during the output\'s reconnect blip does not steal the session', async () => {
    const w = world({ activeGraceMs: 200 });
    const a = w.device('A');
    const b = w.device('B');
    b.playLocally(T1);
    b.disconnect();
    a.playLocally(T2);
    expect(a.audible).toBe(false);
    b.connect();
    expect(w.audible()).toEqual(['B']);
    expect(b.track).toEqual(T2);
  });
});

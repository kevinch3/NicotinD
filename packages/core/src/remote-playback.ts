/**
 * Remote playback — the client's protocol decisions as pure functions.
 *
 * `RemotePlaybackService` (web) feeds every server frame through
 * `reduceServerMessage` and applies the returned effects to the player; the
 * api-side multi-device simulation drives the very same functions against the
 * real server handlers. Keeping the decisions here is what makes that
 * simulation faithful rather than a hand-written model that drifts (#877).
 *
 * The rules, in one place:
 * - Commands drive execution, STATE_SYNC drives UI. Only a snapshot reply (a
 *   STATE_SYNC carrying `devices`, sent on REGISTER) may load a track on the
 *   output device — that is the reconnect-while-active path.
 * - Exactly one device is the audio output. A device that stops being it
 *   yields (pauses its player), and a session ending (`activeDeviceId` → null)
 *   resumes nothing: the former controller stays paused rather than waking its
 *   speaker because a link dropped.
 * - `null` is "no session", not "me": a stale server track is never loaded
 *   into a device that merely connected.
 */

export interface RemoteTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  coverArt?: string;
  duration?: number;
}

export interface RemoteDevice {
  id: string;
  name: string;
  type: string;
  lastSeen: number;
}

/** The server's shared state as it appears on the wire (all fields optional
 *  so a partial or older server still parses). */
export interface RemotePlaybackSnapshot {
  activeDeviceId?: string | null;
  isPlaying?: boolean;
  track?: RemoteTrack | null;
  position?: number;
  duration?: number;
}

export type ServerMessage =
  | { type: 'STATE_SYNC'; payload: { state: RemotePlaybackSnapshot; devices?: RemoteDevice[] } }
  | { type: 'DEVICES_SYNC'; payload: { devices: RemoteDevice[] } }
  | { type: 'COMMAND'; payload: { action: string; track?: RemoteTrack; position?: number } }
  | { type: 'HEARTBEAT_ACK'; payload: Record<string, never> };

export type ClientMessage =
  | { type: 'SET_ACTIVE_DEVICE'; payload: { id: string } }
  | { type: 'COMMAND'; payload: { action: 'SET_TRACK'; track: RemoteTrack } }
  | {
      type: 'STATE_UPDATE';
      payload: {
        state: { track: RemoteTrack; trackId: string; isPlaying: boolean; position: number };
      };
    };

/** What the client knows about the session — mirrored 1:1 by the service's signals. */
export interface RemoteClientState {
  activeDeviceId: string | null;
  devices: RemoteDevice[];
  remoteIsPlaying: boolean;
  remotePosition: number;
  /** Wall-clock ms when `remotePosition` was received — for interpolation. */
  remotePositionTs: number;
  remoteDuration: number;
  /** The track last applied from the server; the echo guard for SET_TRACK. */
  lastRemoteTrackId: string | null;
}

/** Local facts the decisions need; owned by the player and the settings. */
export interface RemoteClientContext {
  myId: string;
  remoteEnabled: boolean;
  localTrackId: string | null;
  now: number;
}

export type PlayerEffect =
  | { kind: 'play'; track: RemoteTrack }
  | { kind: 'resume' }
  | { kind: 'pause' }
  | { kind: 'seek'; position: number }
  | { kind: 'next' }
  | { kind: 'prev' }
  /** Mirror metadata on a controller — no audio is loaded. */
  | { kind: 'show-track'; track: RemoteTrack }
  /** This device stopped being the output: pause the local player. */
  | { kind: 'yield' }
  /** This device took the session back: continue locally from here. */
  | { kind: 'resume-local'; position: number; playing: boolean };

export interface Reduction {
  state: RemoteClientState;
  effects: PlayerEffect[];
}

export function initialRemoteClientState(): RemoteClientState {
  return {
    activeDeviceId: null,
    devices: [],
    remoteIsPlaying: false,
    remotePosition: 0,
    remotePositionTs: 0,
    remoteDuration: 0,
    lastRemoteTrackId: null,
  };
}

/** Whether this device plays audio: no session, or a session naming it. */
export function isAudioOutput(activeDeviceId: string | null, myId: string): boolean {
  return activeDeviceId === null || activeDeviceId === myId;
}

export function reduceServerMessage(
  state: RemoteClientState,
  ctx: RemoteClientContext,
  msg: ServerMessage,
): Reduction {
  switch (msg.type) {
    case 'STATE_SYNC':
      return reduceStateSync(state, ctx, msg.payload.state, msg.payload.devices);
    case 'DEVICES_SYNC':
      return { state: { ...state, devices: msg.payload.devices }, effects: [] };
    case 'COMMAND':
      return reduceCommand(state, ctx, msg.payload);
    default:
      return { state, effects: [] };
  }
}

function reduceStateSync(
  prev: RemoteClientState,
  ctx: RemoteClientContext,
  snap: RemotePlaybackSnapshot,
  devices: RemoteDevice[] | undefined,
): Reduction {
  const effects: PlayerEffect[] = [];
  const next: RemoteClientState = { ...prev };

  if (snap.activeDeviceId !== undefined) next.activeDeviceId = snap.activeDeviceId ?? null;
  if (devices) next.devices = devices;
  if (snap.isPlaying !== undefined) next.remoteIsPlaying = snap.isPlaying;
  if (snap.position !== undefined) {
    next.remotePosition = snap.position;
    next.remotePositionTs = ctx.now;
    next.remoteDuration = snap.duration ?? snap.track?.duration ?? 0;
  }

  const wasOutput = isAudioOutput(prev.activeDeviceId, ctx.myId);
  const isOutput = isAudioOutput(next.activeDeviceId, ctx.myId);
  if (wasOutput && !isOutput) effects.push({ kind: 'yield' });
  // The session this device was controlling ended (the receiver dropped or
  // opted out). The controller's player is logically playing again as soon as
  // the user picked a track while remote, so pause explicitly: a speaker never
  // starts on its own because a link went away. The former output device and
  // bystanders are left alone.
  if (!wasOutput && next.activeDeviceId === null) effects.push({ kind: 'pause' });

  const amActive = next.activeDeviceId === ctx.myId;
  const snapshotReply = devices !== undefined;

  // Reconnect while active: the session may have moved on while this socket
  // was down (a SET_TRACK broadcast reaches nobody who is offline).
  if (snapshotReply && amActive && ctx.remoteEnabled && snap.track) {
    if (snap.track.id !== ctx.localTrackId) {
      next.lastRemoteTrackId = snap.track.id;
      effects.push({ kind: 'play', track: snap.track });
      if (snap.isPlaying === false) effects.push({ kind: 'pause' });
      if (snap.position) effects.push({ kind: 'seek', position: snap.position });
    }
  }

  // Controller: mirror the remote track so the player bar shows it.
  const hasSession = typeof next.activeDeviceId === 'string';
  if (!amActive && hasSession && ctx.remoteEnabled && snap.track) {
    if (snap.track.id !== ctx.localTrackId) {
      next.lastRemoteTrackId = snap.track.id;
      effects.push({ kind: 'show-track', track: snap.track });
    }
  }

  return { state: next, effects };
}

function reduceCommand(
  state: RemoteClientState,
  ctx: RemoteClientContext,
  payload: { action: string; track?: RemoteTrack; position?: number },
): Reduction {
  // Only the active, opted-in device executes. `null` is not "me": with no
  // session a stray command must not start audio on every connected device.
  if (state.activeDeviceId !== ctx.myId || !ctx.remoteEnabled) return { state, effects: [] };

  switch (payload.action) {
    case 'PLAY':
      return { state, effects: [{ kind: 'resume' }] };
    case 'PAUSE':
      return { state, effects: [{ kind: 'pause' }] };
    case 'SEEK':
      return payload.position === undefined
        ? { state, effects: [] }
        : { state, effects: [{ kind: 'seek', position: payload.position }] };
    case 'SET_TRACK':
      return payload.track
        ? {
            state: { ...state, lastRemoteTrackId: payload.track.id },
            effects: [{ kind: 'play', track: payload.track }],
          }
        : { state, effects: [] };
    case 'NEXT':
      return { state, effects: [{ kind: 'next' }] };
    case 'PREV':
      return { state, effects: [{ kind: 'prev' }] };
    default:
      return { state, effects: [] };
  }
}

/** The local player moved to a new track. A controller forwards it to the
 *  session (unless the server just told it about that very track); the output
 *  device — or a device with no session — reports it as state so a controller
 *  can mirror it. */
export function onLocalTrackChanged(
  state: RemoteClientState,
  ctx: RemoteClientContext,
  track: RemoteTrack,
): { messages: ClientMessage[] } {
  if (!isAudioOutput(state.activeDeviceId, ctx.myId)) {
    if (track.id === state.lastRemoteTrackId) return { messages: [] };
    return { messages: [{ type: 'COMMAND', payload: { action: 'SET_TRACK', track } }] };
  }
  return {
    messages: [
      {
        type: 'STATE_UPDATE',
        payload: { state: { track, trackId: track.id, isPlaying: true, position: 0 } },
      },
    ],
  };
}

/** The user picked an output device in the switcher. */
export function castTo(
  state: RemoteClientState,
  ctx: RemoteClientContext,
  targetId: string,
  currentTrack: RemoteTrack | null,
): Reduction & { messages: ClientMessage[] } {
  const next = { ...state, activeDeviceId: targetId };
  const messages: ClientMessage[] = [{ type: 'SET_ACTIVE_DEVICE', payload: { id: targetId } }];

  if (targetId === ctx.myId) {
    // Taking the session back: continue where the remote device was. Its last
    // reported position ages by wall-clock while it plays.
    const elapsed = state.remoteIsPlaying ? (ctx.now - state.remotePositionTs) / 1000 : 0;
    const position = Math.max(0, state.remotePosition + elapsed);
    return {
      state: next,
      effects: [{ kind: 'resume-local', position, playing: state.remoteIsPlaying }],
      messages,
    };
  }

  if (currentTrack) {
    messages.push({ type: 'COMMAND', payload: { action: 'SET_TRACK', track: currentTrack } });
  }
  // Handing off pauses the local player *logically*, not just the element: a
  // later `activeDeviceId → null` must not wake this speaker (#877).
  return { state: next, effects: [{ kind: 'yield' }], messages };
}

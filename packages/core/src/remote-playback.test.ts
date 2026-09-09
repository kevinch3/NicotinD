import { describe, expect, it } from 'bun:test';
import {
  castTo,
  claimOutput,
  hasControllableSession,
  initialRemoteClientState,
  isAudioOutput,
  onLocalPlayingChanged,
  onLocalTrackChanged,
  reduceServerMessage,
  type RemoteClientContext,
  type RemoteClientState,
  type RemotePlaybackSnapshot,
  type ServerMessage,
} from './remote-playback.js';

const t1 = { id: 't1', title: 'One', artist: 'A' };
const t2 = { id: 't2', title: 'Two', artist: 'A' };

const ctx = (over: Partial<RemoteClientContext> = {}): RemoteClientContext => ({
  myId: 'me',
  remoteEnabled: true,
  localTrackId: null,
  now: 1000,
  ...over,
});

const state = (over: Partial<RemoteClientState> = {}): RemoteClientState => ({
  ...initialRemoteClientState(),
  ...over,
});

const sync = (
  snapshot: RemotePlaybackSnapshot,
  devices?: { id: string; name: string; type: string; lastSeen: number }[],
): ServerMessage => ({
  type: 'STATE_SYNC',
  payload: { state: snapshot, ...(devices && { devices }) },
});

const kinds = (r: { effects: { kind: string }[] }) => r.effects.map((e) => e.kind);

describe('isAudioOutput', () => {
  it('no session means every device is its own output', () => {
    expect(isAudioOutput(null, 'me')).toBe(true);
  });
  it('a session names exactly one output', () => {
    expect(isAudioOutput('me', 'me')).toBe(true);
    expect(isAudioOutput('tv', 'me')).toBe(false);
  });
});

describe('STATE_SYNC — who is the output', () => {
  it('a device that stops being the output yields its local playback', () => {
    const r = reduceServerMessage(state(), ctx(), sync({ activeDeviceId: 'tv' }));
    expect(kinds(r)).toEqual(['yield']);
    expect(r.state.activeDeviceId).toBe('tv');
  });

  it('the session ending (active → null) pauses the former controller rather than waking it', () => {
    // Picking a track while remote re-arms the local player (`play()` sets
    // isPlaying), so a session that ends must pause explicitly; the speaker
    // that used to be the controller never starts on its own.
    const r = reduceServerMessage(
      state({ activeDeviceId: 'tv', remoteIsPlaying: true }),
      ctx({ localTrackId: 't1' }),
      sync({ activeDeviceId: null, isPlaying: false, track: t1 }),
    );
    expect(kinds(r)).toEqual(['pause']);
    expect(r.state.activeDeviceId).toBeNull();
  });

  it('the session ending leaves the former output device alone', () => {
    const r = reduceServerMessage(
      state({ activeDeviceId: 'me' }),
      ctx({ localTrackId: 't1' }),
      sync({ activeDeviceId: null, isPlaying: false, track: t1 }),
    );
    expect(kinds(r)).toEqual([]);
  });

  it('the session ending leaves an uninvolved device alone', () => {
    const r = reduceServerMessage(
      state({ activeDeviceId: null }),
      ctx({ localTrackId: 't1' }),
      sync({ activeDeviceId: null, isPlaying: false, track: t1 }),
    );
    expect(kinds(r)).toEqual([]);
  });

  it('staying the output yields nothing', () => {
    const r = reduceServerMessage(
      state({ activeDeviceId: 'me' }),
      ctx(),
      sync({ activeDeviceId: 'me' }),
    );
    expect(kinds(r)).toEqual([]);
  });
});

describe('STATE_SYNC — the controller mirrors the remote session', () => {
  it('shows the remote track without loading audio', () => {
    const r = reduceServerMessage(
      state({ activeDeviceId: 'tv' }),
      ctx({ localTrackId: 't0' }),
      sync({ activeDeviceId: 'tv', track: t1 }),
    );
    expect(r.effects).toEqual([{ kind: 'show-track', track: t1 }]);
    expect(r.state.lastRemoteTrackId).toBe('t1');
  });

  it('tracks the remote play state and position, stamped with the receive time', () => {
    const r = reduceServerMessage(
      state({ activeDeviceId: 'tv' }),
      ctx({ localTrackId: 't1', now: 5000 }),
      sync({ activeDeviceId: 'tv', isPlaying: true, position: 42, duration: 200, track: t1 }),
    );
    expect(r.state.remoteIsPlaying).toBe(true);
    expect(r.state.remotePosition).toBe(42);
    expect(r.state.remotePositionTs).toBe(5000);
    expect(r.state.remoteDuration).toBe(200);
    expect(kinds(r)).toEqual([]);
  });

  it('falls back to the track duration when the receiver has not reported one', () => {
    const r = reduceServerMessage(
      state({ activeDeviceId: 'tv' }),
      ctx({ localTrackId: 't1' }),
      sync({ activeDeviceId: 'tv', position: 1, track: { ...t1, duration: 300 } }),
    );
    expect(r.state.remoteDuration).toBe(300);
  });
});

describe('STATE_SYNC — a snapshot reply reconciles the active device', () => {
  const devices = [{ id: 'me', name: 'Me', type: 'web', lastSeen: 0 }];

  it('adopts the server track and position it does not have (reconnect while active)', () => {
    const r = reduceServerMessage(
      state({ activeDeviceId: 'me' }),
      ctx({ localTrackId: 't0' }),
      sync({ activeDeviceId: 'me', track: t1, position: 30, isPlaying: true }, devices),
    );
    expect(r.effects).toEqual([
      { kind: 'play', track: t1 },
      { kind: 'seek', position: 30 },
    ]);
    expect(r.state.lastRemoteTrackId).toBe('t1');
    expect(r.state.devices).toEqual(devices);
  });

  it('adopts a paused session as paused', () => {
    const r = reduceServerMessage(
      state(),
      ctx({ localTrackId: null }),
      sync({ activeDeviceId: 'me', track: t1, position: 0, isPlaying: false }, devices),
    );
    expect(r.effects).toEqual([{ kind: 'play', track: t1 }, { kind: 'pause' }]);
  });

  it('is a no-op when the track is already loaded', () => {
    const r = reduceServerMessage(
      state({ activeDeviceId: 'me' }),
      ctx({ localTrackId: 't1' }),
      sync({ activeDeviceId: 'me', track: t1, position: 30 }, devices),
    );
    expect(kinds(r)).toEqual([]);
  });

  it('never loads a stale server track when there is no session', () => {
    const r = reduceServerMessage(
      state(),
      ctx({ localTrackId: null }),
      sync({ activeDeviceId: null, track: t1, position: 30 }, devices),
    );
    expect(kinds(r)).toEqual([]);
  });

  it('never loads a track on a device that has opted out', () => {
    const r = reduceServerMessage(
      state(),
      ctx({ localTrackId: null, remoteEnabled: false }),
      sync({ activeDeviceId: 'me', track: t1 }, devices),
    );
    expect(kinds(r)).toEqual([]);
  });

  it('a plain broadcast (no devices) never loads a track — commands drive execution', () => {
    const r = reduceServerMessage(
      state({ activeDeviceId: 'me' }),
      ctx({ localTrackId: 't1' }),
      sync({ activeDeviceId: 'me', track: t2 }),
    );
    expect(kinds(r)).toEqual([]);
  });
});

describe('DEVICES_SYNC', () => {
  it('replaces the device list', () => {
    const devices = [{ id: 'tv', name: 'TV', type: 'web', lastSeen: 0 }];
    const r = reduceServerMessage(state(), ctx(), { type: 'DEVICES_SYNC', payload: { devices } });
    expect(r.state.devices).toBe(devices);
    expect(kinds(r)).toEqual([]);
  });
});

describe('COMMAND', () => {
  const cmd = (action: string, extra: Record<string, unknown> = {}): ServerMessage => ({
    type: 'COMMAND',
    payload: { action, ...extra },
  });

  it('executes on the active, opted-in device', () => {
    const s = state({ activeDeviceId: 'me' });
    expect(kinds(reduceServerMessage(s, ctx(), cmd('PLAY')))).toEqual(['resume']);
    expect(kinds(reduceServerMessage(s, ctx(), cmd('PAUSE')))).toEqual(['pause']);
    expect(reduceServerMessage(s, ctx(), cmd('SEEK', { position: 7 })).effects).toEqual([
      { kind: 'seek', position: 7 },
    ]);
    expect(kinds(reduceServerMessage(s, ctx(), cmd('NEXT')))).toEqual(['next']);
    expect(kinds(reduceServerMessage(s, ctx(), cmd('PREV')))).toEqual(['prev']);
  });

  it('SET_TRACK loads the track and remembers it as remote-applied', () => {
    const r = reduceServerMessage(
      state({ activeDeviceId: 'me' }),
      ctx(),
      cmd('SET_TRACK', { track: t1 }),
    );
    expect(r.effects).toEqual([{ kind: 'play', track: t1 }]);
    expect(r.state.lastRemoteTrackId).toBe('t1');
  });

  it('is ignored by a device that is not the output', () => {
    expect(kinds(reduceServerMessage(state({ activeDeviceId: 'tv' }), ctx(), cmd('PLAY')))).toEqual(
      [],
    );
  });

  it('is ignored when no session exists (null is not "me")', () => {
    expect(kinds(reduceServerMessage(state(), ctx(), cmd('PLAY')))).toEqual([]);
  });

  it('is ignored by a device that has opted out', () => {
    const r = reduceServerMessage(
      state({ activeDeviceId: 'me' }),
      ctx({ remoteEnabled: false }),
      cmd('PLAY'),
    );
    expect(kinds(r)).toEqual([]);
  });
});

describe('onLocalTrackChanged', () => {
  it('a controller forwards a new track to the session as SET_TRACK', () => {
    const listed = [{ id: 'tv', name: 'TV', type: 'web', lastSeen: 0 }];
    const r = onLocalTrackChanged(state({ activeDeviceId: 'tv', devices: listed }), ctx(), t2);
    expect(r.messages).toEqual([{ type: 'COMMAND', payload: { action: 'SET_TRACK', track: t2 } }]);
  });

  it('a controller does not echo back the track the server just told it about', () => {
    const r = onLocalTrackChanged(
      state({ activeDeviceId: 'tv', lastRemoteTrackId: 't1' }),
      ctx(),
      t1,
    );
    expect(r.messages).toEqual([]);
  });

  it('the output device reports a locally chosen track as state', () => {
    const r = onLocalTrackChanged(state({ activeDeviceId: 'me' }), ctx(), t2);
    expect(r.messages).toEqual([
      {
        type: 'STATE_UPDATE',
        payload: { state: { track: t2, trackId: 't2', isPlaying: true, position: 0 } },
      },
    ]);
  });

  it('with no session a device still reports its track so a later controller can mirror it', () => {
    const r = onLocalTrackChanged(state(), ctx(), t2);
    expect(r.messages.map((m) => m.type)).toEqual(['STATE_UPDATE']);
  });
});

describe('castTo', () => {
  it('handing the session to another device yields local playback and sends the track along', () => {
    const r = castTo(state(), ctx({ localTrackId: 't1' }), 'tv', t1);
    expect(r.state.activeDeviceId).toBe('tv');
    expect(r.effects).toEqual([{ kind: 'yield' }]);
    expect(r.messages).toEqual([
      { type: 'SET_ACTIVE_DEVICE', payload: { id: 'tv' } },
      { type: 'COMMAND', payload: { action: 'SET_TRACK', track: t1 } },
    ]);
  });

  it('with no local track, only the session handoff is sent', () => {
    const r = castTo(state(), ctx(), 'tv', null);
    expect(r.messages).toEqual([{ type: 'SET_ACTIVE_DEVICE', payload: { id: 'tv' } }]);
  });

  it('taking the session back resumes locally where the remote device was', () => {
    const r = castTo(
      state({
        activeDeviceId: 'tv',
        remoteIsPlaying: true,
        remotePosition: 40,
        remotePositionTs: 1000,
      }),
      ctx({ localTrackId: 't1', now: 3000 }),
      'me',
      t1,
    );
    expect(r.state.activeDeviceId).toBe('me');
    expect(r.effects).toEqual([{ kind: 'resume-local', position: 42, playing: true }]);
    expect(r.messages).toEqual([{ type: 'SET_ACTIVE_DEVICE', payload: { id: 'me' } }]);
  });

  it('taking back a paused session stays paused at the remote position', () => {
    const r = castTo(
      state({
        activeDeviceId: 'tv',
        remoteIsPlaying: false,
        remotePosition: 40,
        remotePositionTs: 1000,
      }),
      ctx({ localTrackId: 't1', now: 9000 }),
      'me',
      t1,
    );
    expect(r.effects).toEqual([{ kind: 'resume-local', position: 40, playing: false }]);
  });
});

const tv = { id: 'tv', name: 'TV', type: 'web', lastSeen: 0 };

describe('hasControllableSession', () => {
  it('no session is not controllable', () => {
    expect(hasControllableSession(state({ devices: [tv] }))).toBe(false);
  });
  it('a session naming a listed, available device is controllable', () => {
    expect(hasControllableSession(state({ activeDeviceId: 'tv', devices: [tv] }))).toBe(true);
    expect(
      hasControllableSession(
        state({ activeDeviceId: 'tv', devices: [{ ...tv, available: true }] }),
      ),
    ).toBe(true);
  });
  it('an output that opted out or is not listed cannot be driven', () => {
    expect(
      hasControllableSession(
        state({ activeDeviceId: 'tv', devices: [{ ...tv, available: false }] }),
      ),
    ).toBe(false);
    expect(hasControllableSession(state({ activeDeviceId: 'tv', devices: [] }))).toBe(false);
  });
  it('an output in its reconnect grace is still driven — a blip must not lose the picks', () => {
    expect(
      hasControllableSession(state({ activeDeviceId: 'tv', devices: [{ ...tv, pending: true }] })),
    ).toBe(true);
  });
});

describe('claimOutput', () => {
  it('sends one CLAIM_OUTPUT carrying the track and commits nothing locally', () => {
    const r = claimOutput(state(), ctx(), t1, 12);
    expect(r.messages).toEqual([
      {
        type: 'CLAIM_OUTPUT',
        payload: { track: t1, trackId: 't1', position: 12, isPlaying: true },
      },
    ]);
  });
});

describe('onLocalPlayingChanged', () => {
  it('with no session, starting to play claims the output', () => {
    const r = onLocalPlayingChanged(state(), ctx(), true, t1, 0);
    expect(r.messages.map((m) => m.type)).toEqual(['CLAIM_OUTPUT']);
  });
  it('with no session, pausing reports nothing', () => {
    expect(onLocalPlayingChanged(state(), ctx(), false, t1, 0).messages).toEqual([]);
  });
  it('with no track there is nothing to claim', () => {
    expect(onLocalPlayingChanged(state(), ctx(), true, null, 0).messages).toEqual([]);
  });
  it('the output reports its play and pause transitions as state', () => {
    const s = state({ activeDeviceId: 'me', devices: [tv] });
    expect(onLocalPlayingChanged(s, ctx(), false, t1, 40).messages).toEqual([
      { type: 'STATE_UPDATE', payload: { state: { isPlaying: false, position: 40 } } },
    ]);
    expect(onLocalPlayingChanged(s, ctx(), true, t1, 40).messages).toEqual([
      { type: 'STATE_UPDATE', payload: { state: { isPlaying: true, position: 40 } } },
    ]);
  });
  it('a controller of a controllable session posts nothing — its transport drives the output', () => {
    const s = state({ activeDeviceId: 'tv', devices: [tv] });
    expect(onLocalPlayingChanged(s, ctx(), true, t1, 0).messages).toEqual([]);
    expect(onLocalPlayingChanged(s, ctx(), false, t1, 0).messages).toEqual([]);
  });
  it('a controller whose output cannot be driven claims instead of sending into the void', () => {
    const s = state({ activeDeviceId: 'tv', devices: [{ ...tv, available: false }] });
    expect(onLocalPlayingChanged(s, ctx(), true, t1, 0).messages.map((m) => m.type)).toEqual([
      'CLAIM_OUTPUT',
    ]);
  });
});

describe('onLocalTrackChanged — uncontrollable session', () => {
  it('a pick on a controller whose output opted out claims the output', () => {
    const s = state({ activeDeviceId: 'tv', devices: [{ ...tv, available: false }] });
    const r = onLocalTrackChanged(s, ctx(), t2);
    expect(r.messages.map((m) => m.type)).toEqual(['CLAIM_OUTPUT']);
  });
});

describe('castTo — availability', () => {
  it('refuses a target that is not available', () => {
    const s = state({ devices: [{ ...tv, available: false }] });
    const r = castTo(s, ctx(), 'tv', t1);
    expect(r.messages).toEqual([]);
    expect(r.effects).toEqual([]);
    expect(r.state.activeDeviceId).toBeNull();
  });
});

describe('STATE_SYNC — mirroring is unconditional', () => {
  it('a device that opted out still mirrors the session so its chrome can name the track', () => {
    const r = reduceServerMessage(
      state(),
      ctx({ remoteEnabled: false }),
      sync({ activeDeviceId: 'tv', track: t1 }),
    );
    expect(kinds(r)).toEqual(['yield', 'show-track']);
  });
});

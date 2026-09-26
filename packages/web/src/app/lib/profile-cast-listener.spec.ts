import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProfileCastListener, LISTENER_MAX_FAILURES } from './profile-cast-listener';

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: unknown[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(type: string, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type, payload }) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const TV = 'profile-1:tab-1';

function make() {
  const onCast = vi.fn();
  const onRefused = vi.fn();
  const l = new ProfileCastListener({
    url: 'ws://x/api/ws/playback?token=t',
    registration: () => ({ id: TV, name: 'NicotinD TV', remoteEnabled: true, activated: true }),
    onCast,
    onRefused,
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
  });
  return { l, onCast, onRefused };
}

describe('ProfileCastListener', () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("registers the TV's own device under this person on open", () => {
    const { l } = make();
    l.start();
    FakeSocket.all[0].open();
    expect(FakeSocket.all[0].sent[0]).toEqual({
      type: 'REGISTER',
      payload: {
        id: TV,
        name: 'NicotinD TV',
        deviceType: 'web',
        remoteEnabled: true,
        activated: true,
        compactProgress: true,
      },
    });
  });

  it('the registration echo is never a cast, even when it names this TV', () => {
    const { l, onCast } = make();
    l.start();
    const s = FakeSocket.all[0];
    s.open();
    s.frame('STATE_SYNC', { state: { activeDeviceId: TV }, devices: [] });
    expect(onCast).not.toHaveBeenCalled();
  });

  it('this TV becoming the session output after the echo is a cast — once', () => {
    const { l, onCast } = make();
    l.start();
    const s = FakeSocket.all[0];
    s.open();
    s.frame('STATE_SYNC', { state: { activeDeviceId: null }, devices: [] });
    s.frame('STATE_SYNC', { state: { activeDeviceId: TV } });
    s.frame('STATE_SYNC', { state: { activeDeviceId: TV, isPlaying: true } });
    expect(onCast).toHaveBeenCalledTimes(1);
  });

  it('another device becoming the output is not a cast', () => {
    const { l, onCast } = make();
    l.start();
    const s = FakeSocket.all[0];
    s.open();
    s.frame('STATE_SYNC', { state: { activeDeviceId: null }, devices: [] });
    s.frame('STATE_SYNC', { state: { activeDeviceId: 'phone-1:tab-1' } });
    expect(onCast).not.toHaveBeenCalled();
  });

  it('heartbeats every 30 s while open', () => {
    const { l } = make();
    l.start();
    FakeSocket.all[0].open();
    vi.advanceTimersByTime(30_000);
    expect(FakeSocket.all[0].sent).toContainEqual({ type: 'HEARTBEAT', payload: {} });
  });

  it('reconnects after a drop, and re-seeds from the next echo', () => {
    const { l, onCast } = make();
    l.start();
    FakeSocket.all[0].open();
    FakeSocket.all[0].frame('STATE_SYNC', { state: { activeDeviceId: null }, devices: [] });
    FakeSocket.all[0].drop();
    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].open();
    // The echo after a reconnect names this TV (someone cast while we were down):
    // still an echo, still not a cast — the main socket's own sync handles playback.
    FakeSocket.all[1].frame('STATE_SYNC', { state: { activeDeviceId: TV }, devices: [] });
    expect(onCast).not.toHaveBeenCalled();
  });

  it(`gives up after ${LISTENER_MAX_FAILURES} closes without an open — a dead token`, () => {
    const { l, onRefused } = make();
    l.start();
    for (let i = 0; i < LISTENER_MAX_FAILURES; i++) {
      FakeSocket.all[i].drop();
      vi.advanceTimersByTime(30_000);
    }
    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(FakeSocket.all).toHaveLength(LISTENER_MAX_FAILURES);
  });

  it('stop closes the socket and schedules nothing', () => {
    const { l } = make();
    l.start();
    FakeSocket.all[0].open();
    l.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('update sends UPDATE_DEVICE on the open socket', () => {
    const { l } = make();
    l.start();
    FakeSocket.all[0].open();
    l.update({ activated: true });
    expect(FakeSocket.all[0].sent).toContainEqual({
      type: 'UPDATE_DEVICE',
      payload: { activated: true },
    });
  });
});

import { EventEmitter } from 'node:events';

export type Track = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  coverArt?: string;
  duration?: number;
};

export type PlaybackState = {
  activeDeviceId: string | null;
  isPlaying: boolean;
  volume: number;
  position: number; // in seconds
  duration: number; // actual audio duration reported by active device
  timestamp: number; // to calculate drift
  trackId: string | null;
  track: Track | null;
  queue: string[];
};

export type Device = {
  id: string;
  name: string;
  type: string;
  lastSeen: number;
  remoteEnabled: boolean;
};

export type PlaybackStateOptions = {
  /** How long the active device may be gone (socket closed or pruned) before
   *  the session is released. A reconnect within it keeps the cast. */
  activeGraceMs?: number;
};

export class PlaybackStateManager extends EventEmitter {
  static readonly DEFAULT_ACTIVE_GRACE_MS = 15_000;
  private readonly activeGraceMs: number;
  private pendingRelease: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;

  private state: PlaybackState = {
    activeDeviceId: null,
    isPlaying: false,
    volume: 1.0,
    position: 0,
    duration: 0,
    timestamp: Date.now(),
    trackId: null,
    track: null,
    queue: [],
  };

  private devices = new Map<string, Device>();
  private static STALE_TIMEOUT = 90_000; // 90s — 3 missed heartbeats (30s interval)

  constructor(opts: PlaybackStateOptions = {}) {
    super();
    this.activeGraceMs = opts.activeGraceMs ?? PlaybackStateManager.DEFAULT_ACTIVE_GRACE_MS;
    setInterval(() => this.cleanupStaleDevices(), 30_000);
  }

  getState() {
    return this.state;
  }

  getDevices() {
    return Array.from(this.devices.values()).filter((d) => d.remoteEnabled);
  }

  /** Remove devices that haven't sent a heartbeat within the timeout window. */
  cleanupStaleDevices() {
    const now = Date.now();
    for (const [id, device] of this.devices) {
      if (now - device.lastSeen > PlaybackStateManager.STALE_TIMEOUT) {
        this.unregisterDevice(id);
      }
    }
  }

  /** Update state and broadcast to all clients. */
  updateState(partial: Partial<PlaybackState>) {
    this.state = { ...this.state, ...partial, timestamp: Date.now() };
    this.emit('state_update', this.state);
  }

  /** Update state silently — no broadcast. Used when echoing client STATE_UPDATEs. */
  updateStateQuiet(partial: Partial<PlaybackState>) {
    this.state = { ...this.state, ...partial, timestamp: Date.now() };
  }

  registerDevice(device: Omit<Device, 'lastSeen' | 'remoteEnabled'> & { remoteEnabled?: boolean }) {
    const remoteEnabled = device.remoteEnabled ?? true;
    this.devices.set(device.id, { ...device, remoteEnabled, lastSeen: Date.now() });
    // The active device came back within the grace: the cast survives.
    if (this.pendingRelease?.id === device.id) this.cancelPendingRelease();
    if (!remoteEnabled) this.releaseIfActive(device.id);
    this.emit('devices_update', this.getDevices());
  }

  updateDevice(id: string, fields: Partial<Pick<Device, 'remoteEnabled' | 'name'>>) {
    const device = this.devices.get(id);
    if (device) {
      this.devices.set(id, { ...device, ...fields });
      if (fields.remoteEnabled === false) this.releaseIfActive(id);
      this.emit('devices_update', this.getDevices());
    }
  }

  unregisterDevice(id: string) {
    if (this.state.activeDeviceId === id) {
      this.loseActiveDevice(id);
      return;
    }
    this.devices.delete(id);
    this.emit('devices_update', this.getDevices());
  }

  /** A device that stops being remote-enabled cannot stay the audio output:
   *  the controller would show it as active while the list no longer has it,
   *  and every command would land on a device that ignores them (#877). */
  private releaseIfActive(id: string) {
    if (this.state.activeDeviceId !== id) return;
    this.cancelPendingRelease();
    this.updateState({ activeDeviceId: null, isPlaying: false });
  }

  /** The active device's socket is gone. Keep it listed and active for the
   *  grace so a 1s reconnect blip does not end the session (and does not make
   *  the controller fall back to local audio); release it if it stays gone. */
  private loseActiveDevice(id: string) {
    if (this.pendingRelease?.id === id) return;
    this.cancelPendingRelease();
    const timer = setTimeout(() => {
      this.pendingRelease = null;
      this.devices.delete(id);
      if (this.state.activeDeviceId === id) {
        this.updateState({ activeDeviceId: null, isPlaying: false });
      }
      this.emit('devices_update', this.getDevices());
    }, this.activeGraceMs);
    timer.unref?.();
    this.pendingRelease = { id, timer };
  }

  private cancelPendingRelease() {
    if (!this.pendingRelease) return;
    clearTimeout(this.pendingRelease.timer);
    this.pendingRelease = null;
  }

  /** Record a beat. Returns whether the device was still known — false means
   *  it was pruned as stale and the caller must re-register it (issue #433). */
  heartbeat(id: string): boolean {
    const device = this.devices.get(id);
    if (!device) return false;
    device.lastSeen = Date.now();
    return true;
  }

  emitCommand(payload: Record<string, unknown>) {
    this.emit('command', payload);
  }
}

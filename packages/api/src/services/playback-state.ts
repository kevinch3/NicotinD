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
  /** Opted in to being driven by the user's other devices. */
  remoteEnabled: boolean;
  /** Has had a user gesture, so `audio.play()` is allowed on it. */
  activated: boolean;
};

/** A device as advertised to clients: every connected device, flagged. */
export type PublicDevice = {
  id: string;
  name: string;
  type: string;
  lastSeen: number;
  /** Can be picked as the output and will execute commands. */
  available: boolean;
  /** Its socket is gone and the release grace is running. */
  pending: boolean;
};

export type ClaimSnapshot = {
  track: Track | null;
  trackId: string | null;
  position: number;
  isPlaying: boolean;
};

export type PlaybackStateOptions = {
  /** How long the active device may be gone (socket closed or pruned) before
   *  the session is released. A reconnect within it keeps the cast. */
  activeGraceMs?: number;
  /** How long a session's output may go without reporting play before the
   *  sweep ends the session, so a paused tab left open does not capture every
   *  pick made on another device. */
  idleReleaseMs?: number;
};

export class PlaybackStateManager extends EventEmitter {
  static readonly DEFAULT_ACTIVE_GRACE_MS = 15_000;
  static readonly DEFAULT_IDLE_RELEASE_MS = 10 * 60_000;
  private readonly activeGraceMs: number;
  private readonly idleReleaseMs: number;
  private lastPlayingAt = 0;
  /** Devices whose socket is gone and whose release grace is running. Keyed
   *  by device: a newer output dropping must not cancel an older device's
   *  timer (a single slot did, and the older device then stayed listed until
   *  the stale sweep). */
  private pendingReleases = new Map<string, ReturnType<typeof setTimeout>>();

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
    this.idleReleaseMs = opts.idleReleaseMs ?? PlaybackStateManager.DEFAULT_IDLE_RELEASE_MS;
    setInterval(() => this.cleanupStaleDevices(), 30_000);
  }

  getState() {
    return this.state;
  }

  /** Every connected device, flagged — the chrome may name any of them, the
   *  picker offers only the available ones. */
  getDevices(): PublicDevice[] {
    return Array.from(this.devices.values()).map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      lastSeen: d.lastSeen,
      available: d.remoteEnabled && d.activated,
      pending: this.pendingReleases.has(d.id),
    }));
  }

  /** Listed, available and reachable: a device a controller can point the
   *  session at, and one a claim cannot take the session from. A device in its
   *  reconnect grace is neither — the grace keeps a blip from ending a session
   *  nobody touches, but a play elsewhere must not wait 15 s for a crashed
   *  tab. */
  canTarget(id: string): boolean {
    const d = this.devices.get(id);
    return d !== undefined && d.remoteEnabled && d.activated && !this.pendingReleases.has(id);
  }

  /** A device that started playing wants to be the output. Compare-and-set:
   *  applies when there is no session, when the claimant already holds it, or
   *  when the current output cannot be driven (opted out, no gesture, gone
   *  into its grace). One `updateState`, so bystanders learn the new output
   *  and its track in a single broadcast. */
  claimOutput(id: string, snapshot: ClaimSnapshot): boolean {
    if (!this.devices.has(id)) return false;
    const current = this.state.activeDeviceId;
    if (current !== null && current !== id && this.canTarget(current)) return false;
    // A claim over a pending output leaves its release timer running: the
    // timer drops the dead device from the list and finds the session already
    // moved, so it releases nothing.
    this.cancelPendingRelease(id);
    this.updateState({ activeDeviceId: id, ...snapshot });
    return true;
  }

  /** The output is leaving (pagehide): end the session now, no grace. */
  releaseOutput(id: string) {
    this.releaseIfActive(id);
  }

  /** Remove devices that haven't sent a heartbeat within the timeout window,
   *  and end a session whose output has gone silent about playing. */
  cleanupStaleDevices() {
    const now = Date.now();
    for (const [id, device] of this.devices) {
      if (now - device.lastSeen > PlaybackStateManager.STALE_TIMEOUT) {
        this.unregisterDevice(id);
      }
    }
    if (
      this.state.activeDeviceId !== null &&
      !this.pendingReleases.has(this.state.activeDeviceId) &&
      now - this.lastPlayingAt > this.idleReleaseMs
    ) {
      this.updateState({ activeDeviceId: null, isPlaying: false });
    }
  }

  /** Update state and broadcast to all clients. */
  updateState(partial: Partial<PlaybackState>) {
    this.notePlaying(partial);
    this.state = { ...this.state, ...partial, timestamp: Date.now() };
    this.emit('state_update', this.state);
  }

  /** Update state silently — no broadcast. Used when echoing client STATE_UPDATEs. */
  updateStateQuiet(partial: Partial<PlaybackState>) {
    this.notePlaying(partial);
    this.state = { ...this.state, ...partial, timestamp: Date.now() };
  }

  /** Any signal that the output is playing — or a session change — resets the
   *  idle clock. */
  private notePlaying(partial: Partial<PlaybackState>) {
    if (partial.isPlaying === true || (partial.activeDeviceId ?? null) !== null) {
      this.lastPlayingAt = Date.now();
    }
  }

  registerDevice(
    device: Omit<Device, 'lastSeen' | 'remoteEnabled' | 'activated'> & {
      remoteEnabled?: boolean;
      activated?: boolean;
    },
  ) {
    const remoteEnabled = device.remoteEnabled ?? true;
    const activated = device.activated ?? true;
    this.devices.set(device.id, { ...device, remoteEnabled, activated, lastSeen: Date.now() });
    // The active device came back within the grace: the cast survives.
    this.cancelPendingRelease(device.id);
    if (!remoteEnabled) this.releaseIfActive(device.id);
    this.emit('devices_update', this.getDevices());
  }

  updateDevice(id: string, fields: Partial<Pick<Device, 'remoteEnabled' | 'name' | 'activated'>>) {
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
    this.cancelPendingRelease(id);
    this.updateState({ activeDeviceId: null, isPlaying: false });
  }

  /** The active device's socket is gone. Keep it listed and active for the
   *  grace so a 1s reconnect blip does not end the session (and does not make
   *  the controller fall back to local audio); release it if it stays gone. */
  private loseActiveDevice(id: string) {
    if (this.pendingReleases.has(id)) return;
    const timer = setTimeout(() => {
      this.pendingReleases.delete(id);
      this.devices.delete(id);
      if (this.state.activeDeviceId === id) {
        this.updateState({ activeDeviceId: null, isPlaying: false });
      }
      this.emit('devices_update', this.getDevices());
    }, this.activeGraceMs);
    timer.unref?.();
    this.pendingReleases.set(id, timer);
    // Controllers must hear that the output is pending now, not when the
    // grace ends: it is what turns their next play into a claim.
    this.emit('devices_update', this.getDevices());
  }

  private cancelPendingRelease(id: string) {
    const timer = this.pendingReleases.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pendingReleases.delete(id);
  }

  /** Record a beat. Returns whether the device was still known — false means
   *  it was pruned as stale and the caller must re-register it (issue #433). */
  heartbeat(id: string): boolean {
    return this.markSeen(id, Date.now());
  }

  /** Stamp when a device was last heard from. Returns whether it was known. */
  markSeen(id: string, at: number): boolean {
    const device = this.devices.get(id);
    if (!device) return false;
    device.lastSeen = at;
    return true;
  }

  emitCommand(payload: Record<string, unknown>) {
    this.emit('command', payload);
  }
}

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

export class PlaybackStateManager extends EventEmitter {
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

  constructor() {
    super();
    setInterval(() => this.cleanupStaleDevices(), 30_000);
  }

  getState() {
    return this.state;
  }

  getDevices() {
    return Array.from(this.devices.values()).filter(d => d.remoteEnabled);
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
    this.devices.set(device.id, { ...device, remoteEnabled: device.remoteEnabled ?? true, lastSeen: Date.now() });
    this.emit('devices_update', this.getDevices());
  }

  updateDevice(id: string, fields: Partial<Pick<Device, 'remoteEnabled' | 'name'>>) {
    const device = this.devices.get(id);
    if (device) {
      this.devices.set(id, { ...device, ...fields });
      this.emit('devices_update', this.getDevices());
    }
  }

  unregisterDevice(id: string) {
    this.devices.delete(id);
    if (this.state.activeDeviceId === id) {
      this.updateState({ activeDeviceId: null, isPlaying: false });
    }
    this.emit('devices_update', this.getDevices());
  }

  heartbeat(id: string) {
    const device = this.devices.get(id);
    if (device) {
      device.lastSeen = Date.now();
    }
  }

  emitCommand(payload: Record<string, unknown>) {
    this.emit('command', payload);
  }
}

export const playbackManager = new PlaybackStateManager();

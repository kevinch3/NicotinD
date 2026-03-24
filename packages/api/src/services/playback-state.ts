import { EventEmitter } from 'node:events';

export type PlaybackState = {
  activeDeviceId: string | null;
  isPlaying: boolean;
  volume: number;
  position: number; // in seconds
  timestamp: number; // to calculate drift
  trackId: string | null;
  queue: string[];
};

export type Device = {
  id: string;
  name: string;
  type: string;
  lastSeen: number;
};

export class PlaybackStateManager extends EventEmitter {
  private state: PlaybackState = {
    activeDeviceId: null,
    isPlaying: false,
    volume: 1.0,
    position: 0,
    timestamp: Date.now(),
    trackId: null,
    queue: [],
  };

  private devices = new Map<string, Device>();

  getState() {
    return this.state;
  }

  getDevices() {
    return Array.from(this.devices.values());
  }

  updateState(partial: Partial<PlaybackState>) {
    this.state = { ...this.state, ...partial, timestamp: Date.now() };
    this.emit('state_update', this.state);
  }

  registerDevice(device: Omit<Device, 'lastSeen'>) {
    this.devices.set(device.id, { ...device, lastSeen: Date.now() });
    this.emit('devices_update', this.getDevices());
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
}

export const playbackManager = new PlaybackStateManager();

import { create } from 'zustand';
import { wsClient } from '@/services/ws-client';
import { usePlayerStore } from '@/stores/player';

export type RemoteDevice = {
  id: string;
  name: string;
  type: string;
  lastSeen: number;
};

export type RemotePlaybackState = {
  /** Whether this client has opted in to receive remote play commands */
  remoteEnabled: boolean;
  /** The device that is currently the active audio output */
  activeDeviceId: string | null;
  /** All known connected devices */
  devices: RemoteDevice[];
  /** Whether the device switcher popover is open */
  switcherOpen: boolean;
  /** Reflects the remote device's isPlaying — used by the controller's UI */
  remoteIsPlaying: boolean;
  /** Last known playback position (seconds) reported by the active device */
  remotePosition: number;
  /** Wall-clock ms when remotePosition was received — for interpolation */
  remotePositionTs: number;
  /** Audio duration reported by the active device */
  remoteDuration: number;

  setRemoteEnabled: (enabled: boolean) => void;
  setDevices: (devices: RemoteDevice[]) => void;
  setActiveDeviceId: (id: string | null) => void;
  setSwitcherOpen: (open: boolean) => void;
  setRemoteIsPlaying: (playing: boolean) => void;
  setRemoteProgress: (position: number, duration: number) => void;
  switchToDevice: (id: string) => void;
};

export const useRemotePlaybackStore = create<RemotePlaybackState>((set) => ({
  remoteEnabled: localStorage.getItem('nicotind_remote_enabled') === 'true',
  activeDeviceId: null,
  devices: [],
  switcherOpen: false,
  remoteIsPlaying: false,
  remotePosition: 0,
  remotePositionTs: 0,
  remoteDuration: 0,

  setRemoteEnabled: (enabled) => {
    localStorage.setItem('nicotind_remote_enabled', String(enabled));
    wsClient.updateDevice({ remoteEnabled: enabled });
    set({ remoteEnabled: enabled });
  },
  setDevices: (devices) => set({ devices }),
  setActiveDeviceId: (id) => set({ activeDeviceId: id }),
  setSwitcherOpen: (open) => set({ switcherOpen: open }),
  setRemoteIsPlaying: (playing) => set({ remoteIsPlaying: playing }),
  setRemoteProgress: (position, duration) => set({
    remotePosition: position,
    remotePositionTs: Date.now(),
    remoteDuration: duration,
  }),

  switchToDevice: (id) => {
    wsClient.setActiveDevice(id);
    // Sync whatever track the controller is currently playing to the target device
    const currentTrack = usePlayerStore.getState().currentTrack;
    if (currentTrack) {
      wsClient.sendCommand('SET_TRACK', { track: currentTrack });
    }
    // Optimistically update
    set({ activeDeviceId: id });
  },
}));

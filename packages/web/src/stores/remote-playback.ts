import { create } from 'zustand';
import { wsClient } from '@/services/ws-client';

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

  setRemoteEnabled: (enabled: boolean) => void;
  setDevices: (devices: RemoteDevice[]) => void;
  setActiveDeviceId: (id: string | null) => void;
  setSwitcherOpen: (open: boolean) => void;
  switchToDevice: (id: string) => void;
};

export const useRemotePlaybackStore = create<RemotePlaybackState>((set) => ({
  remoteEnabled: localStorage.getItem('nicotind_remote_enabled') === 'true',
  activeDeviceId: null,
  devices: [],
  switcherOpen: false,

  setRemoteEnabled: (enabled) => {
    localStorage.setItem('nicotind_remote_enabled', String(enabled));
    set({ remoteEnabled: enabled });
  },
  setDevices: (devices) => set({ devices }),
  setActiveDeviceId: (id) => set({ activeDeviceId: id }),
  setSwitcherOpen: (open) => set({ switcherOpen: open }),

  switchToDevice: (id) => {
    wsClient.setActiveDevice(id);
    // Optimistically update
    set({ activeDeviceId: id });
  },
}));

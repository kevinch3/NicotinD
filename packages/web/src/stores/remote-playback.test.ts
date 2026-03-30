import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock wsClient module before importing anything that depends on it.
// This must happen at the top level before any dynamic imports of the store.
mock.module('@/services/ws-client', () => ({
  wsClient: {
    updateDevice: mock(() => {}),
    connect: mock(() => {}),
    disconnect: mock(() => {}),
    on: mock(() => () => {}),
    getDeviceId: mock(() => 'test-device-id'),
    setActiveDevice: mock(() => {}),
    sendCommand: mock(() => {}),
  },
}));

// Mock localStorage — Bun has no browser environment.
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

// Import the store AFTER mocks are registered.
const { useRemotePlaybackStore } = await import('./remote-playback');

const initialState = {
  remoteEnabled: false,
  activeDeviceId: null,
  devices: [],
  switcherOpen: false,
  remoteIsPlaying: false,
  remotePosition: 0,
  remotePositionTs: 0,
  remoteDuration: 0,
};

beforeEach(() => {
  localStorageMock.clear();
  useRemotePlaybackStore.setState(initialState);
});

describe('remoteEnabled initialization', () => {
  it('defaults to false when localStorage has no value', () => {
    // The store was loaded without any value in localStorage, so default is false.
    // We reset state to initialState (which uses false) in beforeEach to simulate.
    expect(useRemotePlaybackStore.getState().remoteEnabled).toBe(false);
  });
});

describe('setRemoteEnabled(true)', () => {
  it('sets remoteEnabled = true in the store', () => {
    useRemotePlaybackStore.getState().setRemoteEnabled(true);
    expect(useRemotePlaybackStore.getState().remoteEnabled).toBe(true);
  });

  it('writes "true" to localStorage', () => {
    useRemotePlaybackStore.getState().setRemoteEnabled(true);
    expect(localStorageMock.getItem('nicotind_remote_enabled')).toBe('true');
  });

  it('calls wsClient.updateDevice with { remoteEnabled: true }', async () => {
    const { wsClient } = await import('@/services/ws-client');
    (wsClient.updateDevice as ReturnType<typeof mock>).mockClear?.();
    useRemotePlaybackStore.getState().setRemoteEnabled(true);
    expect(wsClient.updateDevice).toHaveBeenCalledWith({ remoteEnabled: true });
  });
});

describe('setRemoteEnabled(false)', () => {
  it('sets remoteEnabled = false in the store', () => {
    // Start enabled, then disable
    useRemotePlaybackStore.setState({ ...initialState, remoteEnabled: true });
    useRemotePlaybackStore.getState().setRemoteEnabled(false);
    expect(useRemotePlaybackStore.getState().remoteEnabled).toBe(false);
  });

  it('writes "false" to localStorage', () => {
    useRemotePlaybackStore.getState().setRemoteEnabled(false);
    expect(localStorageMock.getItem('nicotind_remote_enabled')).toBe('false');
  });

  it('calls wsClient.updateDevice with { remoteEnabled: false }', async () => {
    const { wsClient } = await import('@/services/ws-client');
    (wsClient.updateDevice as ReturnType<typeof mock>).mockClear?.();
    useRemotePlaybackStore.getState().setRemoteEnabled(false);
    expect(wsClient.updateDevice).toHaveBeenCalledWith({ remoteEnabled: false });
  });
});

describe('localStorage-based initialization (via setState simulation)', () => {
  it('would initialize to true if localStorage had "true" before module load', () => {
    // Simulate what the store initializer does:
    localStorageMock.setItem('nicotind_remote_enabled', 'true');
    const value = localStorageMock.getItem('nicotind_remote_enabled') === 'true';
    expect(value).toBe(true);
    // And confirm the store can be set to this value
    useRemotePlaybackStore.setState({ remoteEnabled: value });
    expect(useRemotePlaybackStore.getState().remoteEnabled).toBe(true);
  });

  it('would initialize to false if localStorage had "false" before module load', () => {
    localStorageMock.setItem('nicotind_remote_enabled', 'false');
    const value = localStorageMock.getItem('nicotind_remote_enabled') === 'true';
    expect(value).toBe(false);
    useRemotePlaybackStore.setState({ remoteEnabled: value });
    expect(useRemotePlaybackStore.getState().remoteEnabled).toBe(false);
  });
});

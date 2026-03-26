import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { PlaybackStateManager } from './playback-state.js';

describe('PlaybackStateManager', () => {
  let manager: PlaybackStateManager;

  beforeEach(() => {
    manager = new PlaybackStateManager();
  });

  describe('getState', () => {
    it('returns initial state', () => {
      const state = manager.getState();
      expect(state.activeDeviceId).toBeNull();
      expect(state.isPlaying).toBe(false);
      expect(state.volume).toBe(1.0);
      expect(state.position).toBe(0);
      expect(state.trackId).toBeNull();
      expect(state.track).toBeNull();
      expect(state.queue).toEqual([]);
    });
  });

  describe('updateState', () => {
    it('merges partial state', () => {
      manager.updateState({ isPlaying: true, position: 42 });
      const state = manager.getState();
      expect(state.isPlaying).toBe(true);
      expect(state.position).toBe(42);
      // Other fields remain at defaults
      expect(state.volume).toBe(1.0);
      expect(state.activeDeviceId).toBeNull();
    });

    it('updates timestamp on every call', () => {
      const before = Date.now();
      manager.updateState({ isPlaying: true });
      const after = Date.now();
      const ts = manager.getState().timestamp;
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('emits state_update event', () => {
      const handler = mock(() => {});
      manager.on('state_update', handler);
      manager.updateState({ isPlaying: true });
      expect(handler).toHaveBeenCalledTimes(1);
      const emitted = handler.mock.calls[0][0];
      expect(emitted.isPlaying).toBe(true);
    });
  });

  describe('updateStateQuiet', () => {
    it('merges partial state without emitting', () => {
      const handler = mock(() => {});
      manager.on('state_update', handler);
      manager.updateStateQuiet({ position: 99 });
      expect(handler).not.toHaveBeenCalled();
      expect(manager.getState().position).toBe(99);
    });

    it('updates timestamp', () => {
      const before = Date.now();
      manager.updateStateQuiet({ volume: 0.5 });
      const after = Date.now();
      const ts = manager.getState().timestamp;
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });

  describe('registerDevice', () => {
    it('adds device to the list', () => {
      manager.registerDevice({ id: 'd1', name: 'Chrome on Linux', type: 'web' });
      const devices = manager.getDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].id).toBe('d1');
      expect(devices[0].name).toBe('Chrome on Linux');
      expect(devices[0].type).toBe('web');
      expect(devices[0].lastSeen).toBeGreaterThan(0);
    });

    it('emits devices_update event', () => {
      const handler = mock(() => {});
      manager.on('devices_update', handler);
      manager.registerDevice({ id: 'd1', name: 'Test', type: 'web' });
      expect(handler).toHaveBeenCalledTimes(1);
      const devices = handler.mock.calls[0][0];
      expect(devices).toHaveLength(1);
    });

    it('handles multiple devices', () => {
      manager.registerDevice({ id: 'd1', name: 'Device 1', type: 'web' });
      manager.registerDevice({ id: 'd2', name: 'Device 2', type: 'web' });
      expect(manager.getDevices()).toHaveLength(2);
    });
  });

  describe('unregisterDevice', () => {
    it('removes device from the list', () => {
      manager.registerDevice({ id: 'd1', name: 'Test', type: 'web' });
      manager.unregisterDevice('d1');
      expect(manager.getDevices()).toHaveLength(0);
    });

    it('emits devices_update event', () => {
      manager.registerDevice({ id: 'd1', name: 'Test', type: 'web' });
      const handler = mock(() => {});
      manager.on('devices_update', handler);
      manager.unregisterDevice('d1');
      expect(handler).toHaveBeenCalled();
    });

    it('resets activeDeviceId and isPlaying when active device disconnects', () => {
      manager.updateState({ activeDeviceId: 'd1', isPlaying: true });
      manager.registerDevice({ id: 'd1', name: 'Test', type: 'web' });

      manager.unregisterDevice('d1');

      const state = manager.getState();
      expect(state.activeDeviceId).toBeNull();
      expect(state.isPlaying).toBe(false);
    });

    it('does not reset playback when non-active device disconnects', () => {
      manager.updateState({ activeDeviceId: 'd1', isPlaying: true });
      manager.registerDevice({ id: 'd1', name: 'Active', type: 'web' });
      manager.registerDevice({ id: 'd2', name: 'Other', type: 'web' });

      manager.unregisterDevice('d2');

      const state = manager.getState();
      expect(state.activeDeviceId).toBe('d1');
      expect(state.isPlaying).toBe(true);
    });
  });

  describe('heartbeat', () => {
    it('updates lastSeen for known device', () => {
      manager.registerDevice({ id: 'd1', name: 'Test', type: 'web' });
      const before = manager.getDevices()[0].lastSeen;

      // Small delay to ensure timestamp differs
      manager.heartbeat('d1');
      const after = manager.getDevices()[0].lastSeen;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('is a no-op for unknown device', () => {
      // Should not throw
      manager.heartbeat('nonexistent');
      expect(manager.getDevices()).toHaveLength(0);
    });
  });

  describe('emitCommand', () => {
    it('emits command event with action and payload', () => {
      const handler = mock(() => {});
      manager.on('command', handler);

      manager.emitCommand('PLAY', { track: { id: 't1' } });

      expect(handler).toHaveBeenCalledTimes(1);
      const emitted = handler.mock.calls[0][0];
      expect(emitted.action).toBe('PLAY');
      expect(emitted.payload).toEqual({ track: { id: 't1' } });
    });
  });
});

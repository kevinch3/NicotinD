import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { PlaybackStateManager } from './playback-state.js';

describe('PlaybackStateManager', () => {
  let manager: PlaybackStateManager;

  beforeEach(() => {
    manager = new PlaybackStateManager();
  });

  describe('getState', () => {
    it('returns initial state with all default values', () => {
      const state = manager.getState();
      expect(state.activeDeviceId).toBeNull();
      expect(state.isPlaying).toBe(false);
      expect(state.volume).toBe(1.0);
      expect(state.position).toBe(0);
      expect(state.duration).toBe(0);
      expect(state.trackId).toBeNull();
      expect(state.track).toBeNull();
      expect(state.queue).toEqual([]);
    });
  });

  describe('updateState', () => {
    it('merges partial state preserving untouched fields', () => {
      manager.updateState({ isPlaying: true, position: 42 });
      const state = manager.getState();
      expect(state.isPlaying).toBe(true);
      expect(state.position).toBe(42);
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

    it('emits state_update event with full state', () => {
      const handler = mock(() => {});
      manager.on('state_update', handler);
      manager.updateState({ isPlaying: true });
      expect(handler).toHaveBeenCalledTimes(1);
      const emitted = (handler.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(emitted.isPlaying).toBe(true);
    });

    it('allows overwriting previous values', () => {
      manager.updateState({ position: 10 });
      manager.updateState({ position: 50 });
      expect(manager.getState().position).toBe(50);
    });

    it('handles setting track with full metadata', () => {
      const track = { id: 't1', title: 'Song', artist: 'Artist', album: 'Album', duration: 200 };
      manager.updateState({ track, trackId: 't1' });
      expect(manager.getState().track).toEqual(track);
      expect(manager.getState().trackId).toBe('t1');
    });

    it('handles setting track to null', () => {
      manager.updateState({ track: { id: 't1', title: 'S', artist: 'A' }, trackId: 't1' });
      manager.updateState({ track: null, trackId: null });
      expect(manager.getState().track).toBeNull();
      expect(manager.getState().trackId).toBeNull();
    });
  });

  describe('updateStateQuiet', () => {
    it('merges state without emitting state_update', () => {
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

    it('state is visible to subsequent getState calls', () => {
      manager.updateStateQuiet({ isPlaying: true, position: 30 });
      const s = manager.getState();
      expect(s.isPlaying).toBe(true);
      expect(s.position).toBe(30);
    });
  });

  describe('registerDevice', () => {
    it('adds device to the list with lastSeen', () => {
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
      const devices = (handler.mock.calls[0] as unknown[])[0] as unknown[];
      expect(devices).toHaveLength(1);
    });

    it('handles multiple devices', () => {
      manager.registerDevice({ id: 'd1', name: 'Device 1', type: 'web' });
      manager.registerDevice({ id: 'd2', name: 'Device 2', type: 'web' });
      expect(manager.getDevices()).toHaveLength(2);
    });

    it('overwrites device with same id (reconnect)', () => {
      manager.registerDevice({ id: 'd1', name: 'Old Name', type: 'web' });
      manager.registerDevice({ id: 'd1', name: 'New Name', type: 'web' });
      const devices = manager.getDevices();
      expect(devices).toHaveLength(1);
      expect(devices[0].name).toBe('New Name');
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

    it('is safe to unregister a device that does not exist', () => {
      manager.unregisterDevice('nonexistent');
      expect(manager.getDevices()).toHaveLength(0);
    });

    it('emits state_update when resetting active device', () => {
      manager.updateState({ activeDeviceId: 'd1', isPlaying: true });
      manager.registerDevice({ id: 'd1', name: 'Test', type: 'web' });
      const handler = mock(() => {});
      manager.on('state_update', handler);
      manager.unregisterDevice('d1');
      expect(handler).toHaveBeenCalled();
    });
  });

  describe('heartbeat', () => {
    it('updates lastSeen for known device', () => {
      manager.registerDevice({ id: 'd1', name: 'Test', type: 'web' });
      const before = manager.getDevices()[0].lastSeen;
      manager.heartbeat('d1');
      const after = manager.getDevices()[0].lastSeen;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('is a no-op for unknown device', () => {
      manager.heartbeat('nonexistent');
      expect(manager.getDevices()).toHaveLength(0);
    });
  });

  describe('emitCommand', () => {
    it('emits command event with the payload as-is (no nesting)', () => {
      const handler = mock(() => {});
      manager.on('command', handler);

      const payload = { action: 'PLAY' };
      manager.emitCommand(payload);

      expect(handler).toHaveBeenCalledTimes(1);
      const emitted = (handler.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(emitted.action).toBe('PLAY');
      // Must NOT have a nested payload property — that was the old bug
      expect(emitted).not.toHaveProperty('payload');
    });

    it('preserves extra fields in the payload (e.g. position for SEEK)', () => {
      const handler = mock(() => {});
      manager.on('command', handler);

      manager.emitCommand({ action: 'SEEK', position: 45.5 });

      const emitted = (handler.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(emitted.action).toBe('SEEK');
      expect(emitted.position).toBe(45.5);
    });

    it('preserves track object in SET_TRACK payload', () => {
      const handler = mock(() => {});
      manager.on('command', handler);

      const track = { id: 't1', title: 'Song', artist: 'Artist' };
      manager.emitCommand({ action: 'SET_TRACK', track });

      const emitted = (handler.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(emitted.action).toBe('SET_TRACK');
      expect(emitted.track).toEqual(track);
    });
  });

  describe('cleanupStaleDevices', () => {
    it('removes devices that exceeded the stale timeout', () => {
      manager.registerDevice({ id: 'd1', name: 'Stale', type: 'web' });
      // Manually backdate lastSeen
      const device = manager.getDevices().find(d => d.id === 'd1')!;
      device.lastSeen = Date.now() - 100_000; // 100s ago, exceeds 90s timeout

      manager.cleanupStaleDevices();
      expect(manager.getDevices()).toHaveLength(0);
    });

    it('keeps devices within the timeout window', () => {
      manager.registerDevice({ id: 'd1', name: 'Fresh', type: 'web' });
      manager.cleanupStaleDevices();
      expect(manager.getDevices()).toHaveLength(1);
    });

    it('removes stale devices while keeping fresh ones', () => {
      manager.registerDevice({ id: 'd1', name: 'Stale', type: 'web' });
      manager.registerDevice({ id: 'd2', name: 'Fresh', type: 'web' });

      const stale = manager.getDevices().find(d => d.id === 'd1')!;
      stale.lastSeen = Date.now() - 100_000;

      manager.cleanupStaleDevices();
      const remaining = manager.getDevices();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('d2');
    });

    it('resets activeDeviceId when stale active device is cleaned up', () => {
      manager.registerDevice({ id: 'd1', name: 'Active', type: 'web' });
      manager.updateState({ activeDeviceId: 'd1', isPlaying: true });

      const device = manager.getDevices().find(d => d.id === 'd1')!;
      device.lastSeen = Date.now() - 100_000;

      manager.cleanupStaleDevices();
      expect(manager.getState().activeDeviceId).toBeNull();
      expect(manager.getState().isPlaying).toBe(false);
    });

    it('is safe when no devices exist', () => {
      manager.cleanupStaleDevices();
      expect(manager.getDevices()).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('rapid state updates all apply in order', () => {
      manager.updateState({ position: 10 });
      manager.updateState({ position: 20 });
      manager.updateState({ position: 30 });
      expect(manager.getState().position).toBe(30);
    });

    it('concurrent register and unregister leaves correct device list', () => {
      manager.registerDevice({ id: 'd1', name: 'A', type: 'web' });
      manager.registerDevice({ id: 'd2', name: 'B', type: 'web' });
      manager.registerDevice({ id: 'd3', name: 'C', type: 'web' });
      manager.unregisterDevice('d2');
      const ids = manager.getDevices().map(d => d.id);
      expect(ids).toEqual(['d1', 'd3']);
    });

    it('updateState with empty object only updates timestamp', () => {
      const oldState = { ...manager.getState() };
      manager.updateState({});
      const newState = manager.getState();
      expect(newState.isPlaying).toBe(oldState.isPlaying);
      expect(newState.position).toBe(oldState.position);
      expect(newState.timestamp).toBeGreaterThanOrEqual(oldState.timestamp);
    });

    it('duration field is stored and retrievable', () => {
      manager.updateState({ duration: 243.5 });
      expect(manager.getState().duration).toBe(243.5);
    });
  });
});

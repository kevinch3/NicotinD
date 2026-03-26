import { describe, expect, it, beforeEach, mock } from 'bun:test';
import type { WSContext } from 'hono/ws';

// Mock playbackManager before importing websocket module
const mockManager = {
  registerDevice: mock(() => {}),
  unregisterDevice: mock(() => {}),
  heartbeat: mock(() => {}),
  updateState: mock(() => {}),
  updateStateQuiet: mock(() => {}),
  emitCommand: mock(() => {}),
  getState: mock(() => ({
    activeDeviceId: null,
    isPlaying: false,
    volume: 1.0,
    position: 0,
    timestamp: Date.now(),
    trackId: null,
    track: null,
    queue: [],
  })),
  getDevices: mock(() => []),
  on: mock(() => {}),
};

mock.module('./playback-state.js', () => ({
  playbackManager: mockManager,
}));

// Import after mock is set up
const { wsHandlers } = await import('./websocket.js');

function createMockWs(): WSContext & { send: ReturnType<typeof mock> } {
  return { send: mock(() => {}) } as any;
}

function createEvent(data: object): MessageEvent {
  return { data: JSON.stringify(data) } as MessageEvent;
}

describe('wsHandlers', () => {
  beforeEach(() => {
    // Reset all mocks
    mockManager.registerDevice.mockClear();
    mockManager.unregisterDevice.mockClear();
    mockManager.heartbeat.mockClear();
    mockManager.updateState.mockClear();
    mockManager.updateStateQuiet.mockClear();
    mockManager.emitCommand.mockClear();
    mockManager.getState.mockReturnValue({
      activeDeviceId: null,
      isPlaying: false,
      volume: 1.0,
      position: 0,
      timestamp: Date.now(),
      trackId: null,
      track: null,
      queue: [],
    });
    mockManager.getDevices.mockReturnValue([]);
  });

  describe('REGISTER', () => {
    it('registers device and sends STATE_SYNC reply', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      const event = createEvent({
        type: 'REGISTER',
        payload: { id: 'dev1', name: 'Chrome on Linux', deviceType: 'web' },
      });
      wsHandlers.onMessage!(event, ws);

      expect(mockManager.registerDevice).toHaveBeenCalledWith({
        id: 'dev1',
        name: 'Chrome on Linux',
        type: 'web',
      });

      expect(ws.send).toHaveBeenCalledTimes(1);
      const reply = JSON.parse(ws.send.mock.calls[0][0] as string);
      expect(reply.type).toBe('STATE_SYNC');
      expect(reply.payload).toHaveProperty('state');
      expect(reply.payload).toHaveProperty('devices');
    });
  });

  describe('HEARTBEAT', () => {
    it('calls heartbeat with the device id', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      // First register so the connection has an id
      wsHandlers.onMessage!(
        createEvent({ type: 'REGISTER', payload: { id: 'dev1', name: 'Test', deviceType: 'web' } }),
        ws,
      );

      wsHandlers.onMessage!(createEvent({ type: 'HEARTBEAT', payload: {} }), ws);

      expect(mockManager.heartbeat).toHaveBeenCalledWith('dev1');
    });
  });

  describe('STATE_UPDATE', () => {
    it('calls updateStateQuiet — no broadcast', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      const statePartial = { position: 55 };
      wsHandlers.onMessage!(
        createEvent({ type: 'STATE_UPDATE', payload: { state: statePartial } }),
        ws,
      );

      expect(mockManager.updateStateQuiet).toHaveBeenCalledWith(statePartial);
      // updateState (loud) should NOT have been called for STATE_UPDATE
      // (it may be called for other reasons, so we check updateStateQuiet was the one used)
      expect(mockManager.updateStateQuiet).toHaveBeenCalledTimes(1);
    });
  });

  describe('COMMAND', () => {
    it('PLAY updates state and emits command', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(
        createEvent({ type: 'COMMAND', payload: { action: 'PLAY' } }),
        ws,
      );

      expect(mockManager.updateState).toHaveBeenCalledWith({ isPlaying: true });
      expect(mockManager.emitCommand).toHaveBeenCalledWith('PLAY', { action: 'PLAY' });
    });

    it('PAUSE updates state and emits command', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(
        createEvent({ type: 'COMMAND', payload: { action: 'PAUSE' } }),
        ws,
      );

      expect(mockManager.updateState).toHaveBeenCalledWith({ isPlaying: false });
      expect(mockManager.emitCommand).toHaveBeenCalledWith('PAUSE', { action: 'PAUSE' });
    });

    it('SEEK updates position and emits command', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(
        createEvent({ type: 'COMMAND', payload: { action: 'SEEK', position: 30.5 } }),
        ws,
      );

      const call = mockManager.updateState.mock.calls[0][0];
      expect(call.position).toBe(30.5);
      expect(call.timestamp).toBeGreaterThan(0);
      expect(mockManager.emitCommand).toHaveBeenCalled();
    });

    it('VOLUME updates volume', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(
        createEvent({ type: 'COMMAND', payload: { action: 'VOLUME', volume: 0.7 } }),
        ws,
      );

      expect(mockManager.updateState).toHaveBeenCalledWith({ volume: 0.7 });
    });

    it('SET_TRACK updates track and resets position', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      const track = { id: 't1', title: 'Song', artist: 'Artist' };
      wsHandlers.onMessage!(
        createEvent({ type: 'COMMAND', payload: { action: 'SET_TRACK', track } }),
        ws,
      );

      expect(mockManager.updateState).toHaveBeenCalledWith({
        trackId: 't1',
        track,
        isPlaying: false,
        position: 0,
      });
    });

    it('relays all commands via emitCommand', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(
        createEvent({ type: 'COMMAND', payload: { action: 'NEXT' } }),
        ws,
      );

      expect(mockManager.emitCommand).toHaveBeenCalledWith('NEXT', { action: 'NEXT' });
    });
  });

  describe('PROGRESS_REPORT', () => {
    it('updates position when sent by the active device', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      // Register the device
      wsHandlers.onMessage!(
        createEvent({ type: 'REGISTER', payload: { id: 'dev1', name: 'Test', deviceType: 'web' } }),
        ws,
      );

      // Make this device the active one
      mockManager.getState.mockReturnValue({
        activeDeviceId: 'dev1',
        isPlaying: true,
        volume: 1.0,
        position: 0,
        timestamp: Date.now(),
        trackId: null,
        track: null,
        queue: [],
      });

      mockManager.updateState.mockClear();

      wsHandlers.onMessage!(
        createEvent({ type: 'PROGRESS_REPORT', payload: { position: 45.2, duration: 180 } }),
        ws,
      );

      expect(mockManager.updateState).toHaveBeenCalledTimes(1);
      const call = mockManager.updateState.mock.calls[0][0];
      expect(call.position).toBe(45.2);
      expect(call.timestamp).toBeGreaterThan(0);
    });

    it('ignores progress from non-active device', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      // Register as dev1
      wsHandlers.onMessage!(
        createEvent({ type: 'REGISTER', payload: { id: 'dev1', name: 'Test', deviceType: 'web' } }),
        ws,
      );

      // Active device is dev2, not dev1
      mockManager.getState.mockReturnValue({
        activeDeviceId: 'dev2',
        isPlaying: true,
        volume: 1.0,
        position: 0,
        timestamp: Date.now(),
        trackId: null,
        track: null,
        queue: [],
      });

      mockManager.updateState.mockClear();

      wsHandlers.onMessage!(
        createEvent({ type: 'PROGRESS_REPORT', payload: { position: 45.2, duration: 180 } }),
        ws,
      );

      expect(mockManager.updateState).not.toHaveBeenCalled();
    });

    it('ignores progress from unregistered connection', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);
      // Do NOT register — connection id is empty string

      mockManager.getState.mockReturnValue({
        activeDeviceId: '',
        isPlaying: true,
        volume: 1.0,
        position: 0,
        timestamp: Date.now(),
        trackId: null,
        track: null,
        queue: [],
      });

      wsHandlers.onMessage!(
        createEvent({ type: 'PROGRESS_REPORT', payload: { position: 10, duration: 60 } }),
        ws,
      );

      // Empty string is falsy, so the `if (id && ...)` guard prevents the call
      expect(mockManager.updateState).not.toHaveBeenCalled();
    });
  });

  describe('SET_ACTIVE_DEVICE', () => {
    it('updates activeDeviceId', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(
        createEvent({ type: 'SET_ACTIVE_DEVICE', payload: { id: 'dev2' } }),
        ws,
      );

      expect(mockManager.updateState).toHaveBeenCalledWith({ activeDeviceId: 'dev2' });
    });
  });

  describe('onClose', () => {
    it('unregisters the device', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      // Register first
      wsHandlers.onMessage!(
        createEvent({ type: 'REGISTER', payload: { id: 'dev1', name: 'Test', deviceType: 'web' } }),
        ws,
      );

      wsHandlers.onClose!({} as CloseEvent, ws);

      expect(mockManager.unregisterDevice).toHaveBeenCalledWith('dev1');
    });

    it('does not call unregisterDevice for unregistered connections', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);
      // No REGISTER message — id is empty string

      wsHandlers.onClose!({} as CloseEvent, ws);

      expect(mockManager.unregisterDevice).not.toHaveBeenCalled();
    });
  });
});

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
    duration: 0,
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

function defaultState(overrides: Record<string, unknown> = {}) {
  return {
    activeDeviceId: null,
    isPlaying: false,
    volume: 1.0,
    position: 0,
    duration: 0,
    timestamp: Date.now(),
    trackId: null,
    track: null,
    queue: [],
    ...overrides,
  };
}

function registerDevice(ws: WSContext, id = 'dev1', name = 'Test') {
  wsHandlers.onMessage!(
    createEvent({ type: 'REGISTER', payload: { id, name, deviceType: 'web' } }),
    ws,
  );
}

describe('wsHandlers', () => {
  beforeEach(() => {
    mockManager.registerDevice.mockClear();
    mockManager.unregisterDevice.mockClear();
    mockManager.heartbeat.mockClear();
    mockManager.updateState.mockClear();
    mockManager.updateStateQuiet.mockClear();
    mockManager.emitCommand.mockClear();
    mockManager.getState.mockReturnValue(defaultState());
    mockManager.getDevices.mockReturnValue([]);
  });

  describe('REGISTER', () => {
    it('registers device and sends STATE_SYNC reply', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);
      registerDevice(ws, 'dev1', 'Chrome on Linux');

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

    it('defaults deviceType to "web" when omitted', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);
      wsHandlers.onMessage!(
        createEvent({ type: 'REGISTER', payload: { id: 'dev1', name: 'Test' } }),
        ws,
      );

      expect(mockManager.registerDevice).toHaveBeenCalledWith({
        id: 'dev1',
        name: 'Test',
        type: 'web',
      });
    });
  });

  describe('HEARTBEAT', () => {
    it('calls heartbeat with the device id', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);
      registerDevice(ws);

      wsHandlers.onMessage!(createEvent({ type: 'HEARTBEAT', payload: {} }), ws);

      expect(mockManager.heartbeat).toHaveBeenCalledWith('dev1');
    });

    it('does nothing for unregistered connection', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);
      // No register

      wsHandlers.onMessage!(createEvent({ type: 'HEARTBEAT', payload: {} }), ws);

      // heartbeat called with '' which is falsy — guard should skip
      expect(mockManager.heartbeat).not.toHaveBeenCalled();
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
      expect(mockManager.updateStateQuiet).toHaveBeenCalledTimes(1);
    });
  });

  describe('COMMAND', () => {
    it('PLAY updates state and emits flat payload', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(
        createEvent({ type: 'COMMAND', payload: { action: 'PLAY' } }),
        ws,
      );

      expect(mockManager.updateState).toHaveBeenCalledWith({ isPlaying: true });
      expect(mockManager.emitCommand).toHaveBeenCalledWith({ action: 'PLAY' });
    });

    it('PAUSE updates state and emits flat payload', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(
        createEvent({ type: 'COMMAND', payload: { action: 'PAUSE' } }),
        ws,
      );

      expect(mockManager.updateState).toHaveBeenCalledWith({ isPlaying: false });
      expect(mockManager.emitCommand).toHaveBeenCalledWith({ action: 'PAUSE' });
    });

    it('SEEK updates position and emits flat payload with position', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(
        createEvent({ type: 'COMMAND', payload: { action: 'SEEK', position: 30.5 } }),
        ws,
      );

      const call = (mockManager.updateState.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(call.position).toBe(30.5);
      expect(call.timestamp).toBeGreaterThan(0);
      expect(mockManager.emitCommand).toHaveBeenCalledWith({ action: 'SEEK', position: 30.5 });
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

    it('SET_TRACK with null track sets trackId to null', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(
        createEvent({ type: 'COMMAND', payload: { action: 'SET_TRACK', track: null } }),
        ws,
      );

      expect(mockManager.updateState).toHaveBeenCalledWith({
        trackId: null,
        track: null,
        isPlaying: false,
        position: 0,
      });
    });

    it('SET_TRACK without track property sets null', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(
        createEvent({ type: 'COMMAND', payload: { action: 'SET_TRACK' } }),
        ws,
      );

      expect(mockManager.updateState).toHaveBeenCalledWith({
        trackId: null,
        track: null,
        isPlaying: false,
        position: 0,
      });
    });

    it('relays all commands via emitCommand with flat payload', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(
        createEvent({ type: 'COMMAND', payload: { action: 'NEXT' } }),
        ws,
      );

      expect(mockManager.emitCommand).toHaveBeenCalledWith({ action: 'NEXT' });
    });

    it('PREV command is relayed without state update', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(
        createEvent({ type: 'COMMAND', payload: { action: 'PREV' } }),
        ws,
      );

      // PREV has no specific state update — only emitCommand
      expect(mockManager.emitCommand).toHaveBeenCalledWith({ action: 'PREV' });
    });

    it('emitCommand receives the original payload — no double nesting', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      const payload = { action: 'SEEK', position: 99.9 };
      wsHandlers.onMessage!(createEvent({ type: 'COMMAND', payload }), ws);

      const emitted = (mockManager.emitCommand.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(emitted.action).toBe('SEEK');
      expect(emitted.position).toBe(99.9);
      // Must NOT have a nested payload property
      expect(emitted).not.toHaveProperty('payload');
    });

    it('rapid SEEK commands each update state independently', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(createEvent({ type: 'COMMAND', payload: { action: 'SEEK', position: 10 } }), ws);
      wsHandlers.onMessage!(createEvent({ type: 'COMMAND', payload: { action: 'SEEK', position: 50 } }), ws);
      wsHandlers.onMessage!(createEvent({ type: 'COMMAND', payload: { action: 'SEEK', position: 90 } }), ws);

      expect(mockManager.updateState).toHaveBeenCalledTimes(3);
      const lastCall = (mockManager.updateState.mock.calls[2] as unknown[])[0] as Record<string, unknown>;
      expect(lastCall.position).toBe(90);
    });

    it('SEEK then PAUSE then PLAY interleaving', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(createEvent({ type: 'COMMAND', payload: { action: 'SEEK', position: 30 } }), ws);
      wsHandlers.onMessage!(createEvent({ type: 'COMMAND', payload: { action: 'PAUSE' } }), ws);
      wsHandlers.onMessage!(createEvent({ type: 'COMMAND', payload: { action: 'PLAY' } }), ws);

      expect(mockManager.updateState).toHaveBeenCalledTimes(3);
      expect(mockManager.emitCommand).toHaveBeenCalledTimes(3);

      const calls = mockManager.updateState.mock.calls as unknown[][];
      expect((calls[0][0] as Record<string, unknown>).position).toBe(30);
      expect(calls[1][0]).toEqual({ isPlaying: false });
      expect(calls[2][0]).toEqual({ isPlaying: true });
    });

    it('unknown action still relays via emitCommand', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(
        createEvent({ type: 'COMMAND', payload: { action: 'CUSTOM_ACTION', data: 123 } }),
        ws,
      );

      // No updateState for unknown actions
      expect(mockManager.updateState).not.toHaveBeenCalled();
      expect(mockManager.emitCommand).toHaveBeenCalledWith({ action: 'CUSTOM_ACTION', data: 123 });
    });
  });

  describe('PROGRESS_REPORT', () => {
    it('updates position and duration when sent by the active device', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);
      registerDevice(ws);

      mockManager.getState.mockReturnValue(defaultState({ activeDeviceId: 'dev1', isPlaying: true }));
      mockManager.updateState.mockClear();

      wsHandlers.onMessage!(
        createEvent({ type: 'PROGRESS_REPORT', payload: { position: 45.2, duration: 180 } }),
        ws,
      );

      expect(mockManager.updateState).toHaveBeenCalledTimes(1);
      const call = (mockManager.updateState.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(call.position).toBe(45.2);
      expect(call.duration).toBe(180);
      expect(call.timestamp).toBeGreaterThan(0);
    });

    it('ignores progress from non-active device', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);
      registerDevice(ws);

      mockManager.getState.mockReturnValue(defaultState({ activeDeviceId: 'dev2' }));
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
      // No register — id is empty string

      mockManager.getState.mockReturnValue(defaultState({ activeDeviceId: '' }));

      wsHandlers.onMessage!(
        createEvent({ type: 'PROGRESS_REPORT', payload: { position: 10, duration: 60 } }),
        ws,
      );

      expect(mockManager.updateState).not.toHaveBeenCalled();
    });

    it('stores duration from active device progress report', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);
      registerDevice(ws);

      mockManager.getState.mockReturnValue(defaultState({ activeDeviceId: 'dev1' }));
      mockManager.updateState.mockClear();

      wsHandlers.onMessage!(
        createEvent({ type: 'PROGRESS_REPORT', payload: { position: 0, duration: 243.5 } }),
        ws,
      );

      const call = (mockManager.updateState.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(call.duration).toBe(243.5);
    });

    it('handles NaN position gracefully (still calls updateState)', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);
      registerDevice(ws);

      mockManager.getState.mockReturnValue(defaultState({ activeDeviceId: 'dev1' }));
      mockManager.updateState.mockClear();

      wsHandlers.onMessage!(
        createEvent({ type: 'PROGRESS_REPORT', payload: { position: null, duration: 100 } }),
        ws,
      );

      // The handler doesn't validate values — it passes them through
      expect(mockManager.updateState).toHaveBeenCalledTimes(1);
    });

    it('handles zero duration', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);
      registerDevice(ws);

      mockManager.getState.mockReturnValue(defaultState({ activeDeviceId: 'dev1' }));
      mockManager.updateState.mockClear();

      wsHandlers.onMessage!(
        createEvent({ type: 'PROGRESS_REPORT', payload: { position: 5, duration: 0 } }),
        ws,
      );

      const call = (mockManager.updateState.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(call.duration).toBe(0);
      expect(call.position).toBe(5);
    });

    it('rapid progress reports all get processed', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);
      registerDevice(ws);

      mockManager.getState.mockReturnValue(defaultState({ activeDeviceId: 'dev1' }));
      mockManager.updateState.mockClear();

      for (let i = 0; i < 10; i++) {
        wsHandlers.onMessage!(
          createEvent({ type: 'PROGRESS_REPORT', payload: { position: i * 2, duration: 200 } }),
          ws,
        );
      }

      expect(mockManager.updateState).toHaveBeenCalledTimes(10);
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

    it('can set activeDeviceId to null', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onMessage!(
        createEvent({ type: 'SET_ACTIVE_DEVICE', payload: { id: null } }),
        ws,
      );

      expect(mockManager.updateState).toHaveBeenCalledWith({ activeDeviceId: null });
    });
  });

  describe('onClose', () => {
    it('unregisters the device', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);
      registerDevice(ws);

      wsHandlers.onClose!({} as CloseEvent, ws);

      expect(mockManager.unregisterDevice).toHaveBeenCalledWith('dev1');
    });

    it('does not call unregisterDevice for unregistered connections', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      wsHandlers.onClose!({} as CloseEvent, ws);

      expect(mockManager.unregisterDevice).not.toHaveBeenCalled();
    });

    it('handles close after device re-registration', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);
      registerDevice(ws, 'dev1');
      registerDevice(ws, 'dev2'); // re-register with different id

      wsHandlers.onClose!({} as CloseEvent, ws);

      expect(mockManager.unregisterDevice).toHaveBeenCalledWith('dev2');
    });
  });

  describe('error handling', () => {
    it('does not throw on malformed JSON', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      const event = { data: 'not json{{{' } as MessageEvent;
      expect(() => wsHandlers.onMessage!(event, ws)).not.toThrow();
    });

    it('does not throw on unknown message type', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      expect(() =>
        wsHandlers.onMessage!(createEvent({ type: 'UNKNOWN_TYPE', payload: {} }), ws),
      ).not.toThrow();
    });

    it('does not throw on missing payload', () => {
      const ws = createMockWs();
      wsHandlers.onOpen!({} as Event, ws);

      // Valid JSON but no payload — COMMAND handler accesses data.payload.action
      // This will throw inside the try/catch, which is caught silently
      expect(() =>
        wsHandlers.onMessage!(createEvent({ type: 'COMMAND' }), ws),
      ).not.toThrow();
    });
  });

  describe('multiple connections', () => {
    it('each connection tracks its own device id', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      wsHandlers.onOpen!({} as Event, ws1);
      wsHandlers.onOpen!({} as Event, ws2);

      registerDevice(ws1, 'dev1');
      registerDevice(ws2, 'dev2');

      wsHandlers.onClose!({} as CloseEvent, ws1);
      expect(mockManager.unregisterDevice).toHaveBeenCalledWith('dev1');

      mockManager.unregisterDevice.mockClear();
      wsHandlers.onClose!({} as CloseEvent, ws2);
      expect(mockManager.unregisterDevice).toHaveBeenCalledWith('dev2');
    });

    it('heartbeat targets the correct device per connection', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      wsHandlers.onOpen!({} as Event, ws1);
      wsHandlers.onOpen!({} as Event, ws2);

      registerDevice(ws1, 'dev1');
      registerDevice(ws2, 'dev2');

      mockManager.heartbeat.mockClear();
      wsHandlers.onMessage!(createEvent({ type: 'HEARTBEAT', payload: {} }), ws2);
      expect(mockManager.heartbeat).toHaveBeenCalledWith('dev2');
    });
  });
});

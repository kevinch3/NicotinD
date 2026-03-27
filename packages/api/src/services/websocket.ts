import type { WSContext } from 'hono/ws';
import { playbackManager } from './playback-state.js';

const connections = new Map<WSContext, string>();

export const wsHandlers = {
  onOpen: (_event: Event, ws: WSContext) => {
    connections.set(ws, '');
  },
  onMessage: (event: MessageEvent, ws: WSContext) => {
    try {
      const data = JSON.parse(event.data.toString());

      switch (data.type) {
        case 'REGISTER': {
          const id = data.payload.id;
          connections.set(ws, id);
          playbackManager.registerDevice({
            id,
            name: data.payload.name,
            type: data.payload.deviceType || 'web',
          });

          ws.send(JSON.stringify({
            type: 'STATE_SYNC',
            payload: {
              state: playbackManager.getState(),
              devices: playbackManager.getDevices(),
            },
          }));
          break;
        }

        case 'HEARTBEAT': {
          const id = connections.get(ws);
          if (id) playbackManager.heartbeat(id);
          break;
        }

        case 'STATE_UPDATE': {
          const incoming = data.payload.state;
          // Broadcast immediately when the active device reports a new track so controllers
          // see the metadata update without waiting for the next PROGRESS_REPORT.
          // All other state updates (position, volume, etc.) remain quiet to avoid echo.
          const currentTrackId = playbackManager.getState().trackId;
          if (incoming.track !== undefined && incoming.track?.id !== currentTrackId) {
            playbackManager.updateState(incoming);
          } else {
            playbackManager.updateStateQuiet(incoming);
          }
          break;
        }

        case 'COMMAND': {
          const { action } = data.payload;

          // Update server-side state tracking and broadcast STATE_SYNC
          if (action === 'PLAY') {
            playbackManager.updateState({ isPlaying: true });
          } else if (action === 'PAUSE') {
            playbackManager.updateState({ isPlaying: false });
          } else if (action === 'SEEK') {
            playbackManager.updateState({ position: data.payload.position, timestamp: Date.now() });
          } else if (action === 'VOLUME') {
            playbackManager.updateState({ volume: data.payload.volume });
          } else if (action === 'SET_TRACK') {
            playbackManager.updateState({
              trackId: data.payload.track?.id ?? null,
              track: data.payload.track ?? null,
              isPlaying: false,
              position: 0,
            });
          }

          // Relay ALL commands to clients — active device executes, others ignore
          playbackManager.emitCommand(data.payload);
          break;
        }

        case 'PROGRESS_REPORT': {
          const id = connections.get(ws);
          // Only accept progress from the currently active device
          if (id && id === playbackManager.getState().activeDeviceId) {
            playbackManager.updateState({
              position: data.payload.position,
              duration: data.payload.duration,
              isPlaying: true,
              timestamp: Date.now(),
            });
          }
          break;
        }

        case 'SET_ACTIVE_DEVICE': {
          playbackManager.updateState({ activeDeviceId: data.payload.id });
          break;
        }
      }
    } catch (err) {
      console.error('WS parse error', err);
    }
  },
  onClose: (_event: CloseEvent, ws: WSContext) => {
    const id = connections.get(ws);
    if (id) {
      playbackManager.unregisterDevice(id);
    }
    connections.delete(ws);
  },
};

playbackManager.on('state_update', (state) => {
  const msg = JSON.stringify({ type: 'STATE_SYNC', payload: { state } });
  for (const ws of connections.keys()) {
    ws.send(msg);
  }
});

playbackManager.on('devices_update', (devices) => {
  const msg = JSON.stringify({ type: 'DEVICES_SYNC', payload: { devices } });
  for (const ws of connections.keys()) {
    ws.send(msg);
  }
});

playbackManager.on('command', (command) => {
  const msg = JSON.stringify({ type: 'COMMAND', payload: command });
  for (const ws of connections.keys()) {
    ws.send(msg);
  }
});

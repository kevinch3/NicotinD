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

      console.debug(`[WS-srv] recv ${data.type} from=${connections.get(ws) || '(unregistered)'}`, data.payload);

      switch (data.type) {
        case 'REGISTER': {
          const id = data.payload.id;
          connections.set(ws, id);
          playbackManager.registerDevice({
            id,
            name: data.payload.name,
            type: data.payload.deviceType || 'web',
          });

          const syncPayload = {
            state: playbackManager.getState(),
            devices: playbackManager.getDevices(),
          };
          console.debug('[WS-srv] REGISTER → sending STATE_SYNC to new client', { id, state: syncPayload.state });
          ws.send(JSON.stringify({ type: 'STATE_SYNC', payload: syncPayload }));
          break;
        }

        case 'HEARTBEAT': {
          const id = connections.get(ws);
          if (id) playbackManager.heartbeat(id);
          break;
        }

        case 'STATE_UPDATE': {
          // Update server state silently — no re-broadcast, avoids echo loop.
          playbackManager.updateStateQuiet(data.payload.state);
          break;
        }

        case 'COMMAND': {
          const { action } = data.payload;
          console.debug('[WS-srv] COMMAND action=', action, 'payload=', data.payload);

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
          console.debug('[WS-srv] COMMAND → emitCommand to', connections.size, 'clients');
          playbackManager.emitCommand(data.payload);
          break;
        }

        case 'PROGRESS_REPORT': {
          const id = connections.get(ws);
          const activeId = playbackManager.getState().activeDeviceId;
          const accepted = !!(id && id === activeId);
          console.debug('[WS-srv] PROGRESS_REPORT from=', id, 'activeDevice=', activeId, 'accepted=', accepted);
          // Only accept progress from the currently active device
          if (accepted) {
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
          console.debug('[WS-srv] SET_ACTIVE_DEVICE →', data.payload.id);
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
  console.debug('[WS-srv] broadcast STATE_SYNC →', connections.size, 'clients, isPlaying=', state.isPlaying, 'pos=', state.position?.toFixed?.(1), 'activeDevice=', state.activeDeviceId);
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
  console.debug('[WS-srv] broadcast COMMAND →', connections.size, 'clients, action=', (command as any).action);
  const msg = JSON.stringify({ type: 'COMMAND', payload: command });
  for (const ws of connections.keys()) {
    ws.send(msg);
  }
});

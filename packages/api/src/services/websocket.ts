import { playbackManager } from './playback-state.js';

// We use any to accommodate varying generic typings of Hono's WS object across environments.
const connections = new Map<any, string>();

export const wsHandlers = {
  onOpen: (_event: any, ws: any) => {
    connections.set(ws, '');
  },
  onMessage: (event: any, ws: any) => {
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
              devices: playbackManager.getDevices()
            }
          }));
          break;
        }

        case 'HEARTBEAT': {
          const id = connections.get(ws);
          if (id) playbackManager.heartbeat(id);
          break;
        }

        case 'STATE_UPDATE': {
          playbackManager.updateState(data.payload.state);
          break;
        }

        case 'COMMAND': {
          if (data.payload.action === 'PLAY') playbackManager.updateState({ isPlaying: true });
          if (data.payload.action === 'PAUSE') playbackManager.updateState({ isPlaying: false });
          if (data.payload.action === 'SEEK') playbackManager.updateState({ position: data.payload.position });
          if (data.payload.action === 'VOLUME') playbackManager.updateState({ volume: data.payload.volume });
          if (data.payload.action === 'SET_TRACK') {
            playbackManager.updateState({ 
              trackId: data.payload.trackId,
              isPlaying: true,
              position: 0
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
  onClose: (_event: any, ws: any) => {
    const id = connections.get(ws);
    if (id) {
      playbackManager.unregisterDevice(id);
    }
    connections.delete(ws);
  }
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

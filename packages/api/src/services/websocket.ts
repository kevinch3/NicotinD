import type { WSContext } from 'hono/ws';
import { playbackRegistry } from './playback-registry.js';

interface DeviceRegistration {
  id: string;
  name: string;
  type: string;
  remoteEnabled: boolean;
}

/** The registration is kept alongside the id so a heartbeat can rebuild a
 *  device the stale-sweeper pruned — see the HEARTBEAT case (issue #433). */
const connections = new Map<
  WSContext,
  { deviceId: string; userId: string; registration: DeviceRegistration }
>();
const listenersAttached = new Set<string>();

function attachListeners(userId: string) {
  if (listenersAttached.has(userId)) return;
  listenersAttached.add(userId);

  const manager = playbackRegistry.getOrCreate(userId);

  const broadcast = (msg: string) => {
    for (const [ws, info] of connections) {
      if (info.userId === userId) ws.send(msg);
    }
  };

  manager.on('state_update', (state) => {
    broadcast(JSON.stringify({ type: 'STATE_SYNC', payload: { state } }));
  });

  manager.on('devices_update', (devices) => {
    broadcast(JSON.stringify({ type: 'DEVICES_SYNC', payload: { devices } }));
  });

  manager.on('command', (command) => {
    broadcast(JSON.stringify({ type: 'COMMAND', payload: command }));
  });
}

export function createWebSocketHandlers(userId: string) {
  attachListeners(userId);
  const manager = playbackRegistry.getOrCreate(userId);

  return {
    onOpen: (_event: Event, _ws: WSContext) => {},
    onMessage: (event: MessageEvent, ws: WSContext) => {
      try {
        const data = JSON.parse(event.data.toString());

        switch (data.type) {
          case 'REGISTER': {
            const id = data.payload.id;
            const registration: DeviceRegistration = {
              id,
              name: data.payload.name,
              type: data.payload.deviceType || 'web',
              remoteEnabled: data.payload.remoteEnabled === true,
            };
            connections.set(ws, { deviceId: id, userId, registration });
            manager.registerDevice(registration);

            ws.send(
              JSON.stringify({
                type: 'STATE_SYNC',
                payload: {
                  state: manager.getState(),
                  devices: manager.getDevices(),
                },
              }),
            );
            break;
          }

          case 'HEARTBEAT': {
            const info = connections.get(ws);
            if (!info?.deviceId) break;
            // A device the stale-sweeper pruned must be able to come back on
            // the socket it still owns: REGISTER is only sent from the
            // client's `onopen`, which never fires again while the socket
            // stays OPEN, so without this the device is gone for good
            // (issue #433 — an Android WebView throttles the 30s heartbeat
            // timer behind a TV screensaver, which is what prunes it).
            if (!manager.heartbeat(info.deviceId)) manager.registerDevice(info.registration);
            break;
          }

          case 'STATE_UPDATE': {
            const incoming = data.payload.state;
            // Broadcast immediately when the active device reports a new track so controllers
            // see the metadata update without waiting for the next PROGRESS_REPORT.
            // All other state updates (position, volume, etc.) remain quiet to avoid echo.
            const currentTrackId = manager.getState().trackId;
            if (incoming.track !== undefined && incoming.track?.id !== currentTrackId) {
              manager.updateState(incoming);
            } else {
              manager.updateStateQuiet(incoming);
            }
            break;
          }

          case 'COMMAND': {
            const { action } = data.payload;

            // Update server-side state tracking and broadcast STATE_SYNC
            if (action === 'PLAY') {
              manager.updateState({ isPlaying: true });
            } else if (action === 'PAUSE') {
              manager.updateState({ isPlaying: false });
            } else if (action === 'SEEK') {
              manager.updateState({ position: data.payload.position, timestamp: Date.now() });
            } else if (action === 'VOLUME') {
              manager.updateState({ volume: data.payload.volume });
            } else if (action === 'SET_TRACK') {
              manager.updateState({
                trackId: data.payload.track?.id ?? null,
                track: data.payload.track ?? null,
                isPlaying: true,
                position: 0,
              });
            }

            // Relay ALL commands to clients — active device executes, others ignore
            manager.emitCommand(data.payload);
            break;
          }

          case 'PROGRESS_REPORT': {
            const info = connections.get(ws);
            // Only accept progress from the currently active device
            if (info?.deviceId && info.deviceId === manager.getState().activeDeviceId) {
              manager.updateState({
                position: data.payload.position,
                duration: data.payload.duration,
                isPlaying: true,
                timestamp: Date.now(),
              });
            }
            break;
          }

          case 'SET_ACTIVE_DEVICE': {
            manager.updateState({ activeDeviceId: data.payload.id });
            break;
          }

          case 'UPDATE_DEVICE': {
            const info = connections.get(ws);
            if (info?.deviceId) {
              manager.updateDevice(info.deviceId, {
                remoteEnabled: data.payload.remoteEnabled,
                ...(data.payload.name !== undefined && { name: data.payload.name }),
              });
            }
            break;
          }
        }
      } catch (err) {
        console.error('WS parse error', err);
      }
    },
    onClose: (_event: CloseEvent, ws: WSContext) => {
      const info = connections.get(ws);
      connections.delete(ws);
      if (!info?.deviceId) return;
      // Only drop the device if this socket was the last one holding its id.
      // The client reuses one stable device id across reconnects, so after a
      // Wi-Fi blip the dead socket's close can land *after* the fresh socket
      // has already re-registered — unregistering by id alone evicts the live
      // connection (issue #433).
      for (const other of connections.values()) {
        if (other.userId === userId && other.deviceId === info.deviceId) return;
      }
      manager.unregisterDevice(info.deviceId);
    },
  };
}

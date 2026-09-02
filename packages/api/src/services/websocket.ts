import type { WSContext } from 'hono/ws';
import { playbackRegistry } from './playback-registry.js';
import type { PlaybackStateManager } from './playback-state.js';

interface DeviceRegistration {
  id: string;
  name: string;
  type: string;
  remoteEnabled: boolean;
}

type ConnectionInfo = {
  deviceId: string;
  userId: string;
  registration: DeviceRegistration;
  /** The REGISTER-time context: its `send` closes over the raw socket. */
  ws: WSContext;
};

/** Keyed by the RAW socket, never by the WSContext: Hono's Bun adapter builds a
 *  new WSContext for every event around one stable raw socket, so a WSContext
 *  key matches nothing after REGISTER — heartbeats, progress, opt-out and close
 *  were all silently dropped (issue #877). The registration is kept alongside
 *  the id so any later frame can rebuild a device the stale-sweeper pruned
 *  (issue #433). */
const connectionKey = (ws: WSContext): object => (ws.raw as object | undefined) ?? ws;

/** Where a user's manager comes from — the process-wide registry in prod, a
 *  fresh manager per test in the multi-device harness. */
export interface ManagerSource {
  getOrCreate(userId: string): PlaybackStateManager;
}

/** One hub = one connection table + one set of manager listeners. The process
 *  has one (`createWebSocketHandlers`); a test builds its own so nothing leaks
 *  between scenarios. */
export function createPlaybackHub(registry: ManagerSource = playbackRegistry) {
  const connections = new Map<object, ConnectionInfo>();
  const listenersAttached = new Set<string>();

  function attachListeners(userId: string) {
    if (listenersAttached.has(userId)) return;
    listenersAttached.add(userId);

    const manager = registry.getOrCreate(userId);

    const broadcast = (msg: string) => {
      for (const info of connections.values()) {
        if (info.userId === userId) info.ws.send(msg);
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

  function handlersFor(userId: string) {
    attachListeners(userId);
    const manager = registry.getOrCreate(userId);

    return {
      onOpen: (_event: Event, _ws: WSContext) => {},
      onMessage: (event: MessageEvent, ws: WSContext) => {
        try {
          const data = JSON.parse(event.data.toString());
          const key = connectionKey(ws);
          const info = connections.get(key);

          // Every frame from a registered device is a liveness beat, and heals a
          // stale prune: a receiver reporting progress every 2s must never be
          // dropped because its 30s heartbeat timer was throttled (#877), and the
          // client only sends REGISTER from `onopen`, which never fires again
          // while the socket stays open (#433 — an Android WebView throttles the
          // timer behind a TV screensaver, which is what prunes it).
          if (info && data.type !== 'REGISTER' && !manager.heartbeat(info.deviceId)) {
            manager.registerDevice(info.registration);
          }

          switch (data.type) {
            case 'REGISTER': {
              const id = data.payload.id;
              const registration: DeviceRegistration = {
                id,
                name: data.payload.name,
                type: data.payload.deviceType || 'web',
                remoteEnabled: data.payload.remoteEnabled === true,
              };
              connections.set(key, { deviceId: id, userId, registration, ws });
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
              // The beat itself was recorded above. The ack is what keeps a
              // paused receiver's socket from being *silent* upstream→client
              // (nginx closes a proxied WebSocket after 60s without upstream
              // data by default) and what lets the client notice a half-open
              // socket (#877).
              ws.send(JSON.stringify({ type: 'HEARTBEAT_ACK', payload: {} }));
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
        const key = connectionKey(ws);
        const info = connections.get(key);
        connections.delete(key);
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

  return { handlersFor };
}

const defaultHub = createPlaybackHub();
export const createWebSocketHandlers = defaultHub.handlersFor;

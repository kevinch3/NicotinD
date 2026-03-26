# Remote Playback

NicotinD lets any logged-in browser tab or mobile device become a playback target. One device browses and controls; another plays the audio.

## User guide

### Enabling a device as a receiver

A device must opt in before it can receive remote commands.

1. Open **Settings** on the device you want to use as a speaker.
2. Scroll to the **Remote Playback** section.
3. Toggle **Allow remote control** on.
4. Optionally rename the device (e.g. "Living Room TV", "Phone") so it's easy to identify.

Each browser or tab generates a stable, unique device ID stored in `localStorage`. Reopening the same browser will reconnect under the same name.

### Switching playback to another device

Once at least one other device has opted in and is online:

1. Click the **speaker icon** (🖥️) in the bottom-right corner of the player bar — visible on all screen sizes.
2. The popover lists all connected devices. Select the one you want audio on.
3. The current track is sent to that device immediately. Press play — audio starts there.

The controller's play/pause button, seek bar, and skip controls continue to work normally; they just send commands over the network instead of driving local audio.

### Switching back

Click the speaker icon again and select **your own device** (marked "this device"). Audio returns locally.

---

## Architecture

### Transport

All real-time communication uses a single persistent **WebSocket** at `GET /api/ws/playback`. The server is Bun's native WebSocket via Hono's `createBunWebSocket()`. The client reconnects automatically with exponential backoff (1 s → 2 s → 4 s … 30 s cap).

> **Reverse proxy note:** If the app is served through Cloudflare, **Network → WebSockets must be enabled** in the Cloudflare dashboard. Without it, Cloudflare drops the HTTP `101 Switching Protocols` response when bridging HTTP/2 to the origin.

### Device lifecycle

```
Client connects
  → sends REGISTER { id, name, deviceType }
  → server adds device to in-memory Map, broadcasts DEVICES_SYNC to all
  → server replies with STATE_SYNC (current state + full device list)

Client disconnects / tab closes
  → server removes device, broadcasts DEVICES_SYNC
  → if it was the active device, server clears activeDeviceId
```

Device IDs are generated once per browser profile via `crypto.randomUUID()` and persisted in `localStorage`. The device name is auto-detected from the User-Agent (`"Chrome on Windows"`, `"Safari on iPhone"`, …) and can be overridden by the user.

A 30-second heartbeat keeps the connection alive through idle proxies.

### State model

The server (`PlaybackStateManager`) holds a single shared state object:

```ts
{
  activeDeviceId: string | null   // which device plays audio
  isPlaying:      boolean
  volume:         number          // 0–1
  position:       number          // seconds
  timestamp:      number          // wall-clock ms, used to estimate drift
  trackId:        string | null
  track:          Track | null    // full metadata, synced to late-joining receivers
  queue:          string[]
}
```

State is **in-memory only** — it resets on server restart.

### Message protocol

All frames are JSON: `{ type: string, payload: object }`.

#### Client → Server

| Type | Payload | Purpose |
|------|---------|---------|
| `REGISTER` | `{ id, name, deviceType }` | Announce this device on connect |
| `HEARTBEAT` | `{}` | Keep-alive every 30 s |
| `COMMAND` | `{ action, ...args }` | Send a playback command (see actions below) |
| `SET_ACTIVE_DEVICE` | `{ id }` | Nominate a device as the audio output |
| `STATE_UPDATE` | `{ state }` | Report local state changes (written quietly, no re-broadcast) |

#### Server → All clients

| Type | Payload | Purpose |
|------|---------|---------|
| `STATE_SYNC` | `{ state, devices? }` | Full state snapshot; sent on REGISTER and after any state change |
| `DEVICES_SYNC` | `{ devices }` | Device list after a connect/disconnect |
| `COMMAND` | `{ action, ...args }` | Relay of a command to all clients |

#### COMMAND actions

| Action | Args | Effect |
|--------|------|--------|
| `PLAY` | — | Resume playback |
| `PAUSE` | — | Pause playback |
| `SEEK` | `position: number` | Jump to position in seconds |
| `VOLUME` | `volume: number` | Set volume 0–1 |
| `SET_TRACK` | `track: Track` | Load and queue a new track |
| `NEXT` | — | Skip to next track |
| `PREV` | — | Skip to previous track |

### Command flow (controller → receiver)

```
Controller (Device A)           Server                  Receiver (Device B)
─────────────────────           ──────                  ───────────────────
switchToDevice(B)
  SET_ACTIVE_DEVICE ──────────► updateState(activeDeviceId=B)
                                STATE_SYNC ────────────► setActiveDeviceId(B)  [all devices]
  COMMAND SET_TRACK ──────────► updateState(track=T)
                                COMMAND SET_TRACK ──────► playerPlay(T)  [Device B only, guarded by isActiveDevice && remoteEnabled]

press ▶
  COMMAND PLAY ───────────────► updateState(isPlaying=true)
                                STATE_SYNC ────────────► setRemoteIsPlaying(true)  [controller UI update]
                                COMMAND PLAY ───────────► playerResume()  [Device B only]
```

**Key design decisions:**

- **Commands drive execution, STATE_SYNC drives UI.** Device B executes `PLAY`/`PAUSE`/`SEEK`/`SET_TRACK` only when it receives a `COMMAND` message — not from STATE_SYNC. This avoids the echo loop that occurred when STATE_SYNC triggered a STATE_UPDATE reply that re-triggered another STATE_SYNC.
- **STATE_UPDATE is quiet.** When a device sends `STATE_UPDATE`, the server stores it but does not re-broadcast (`updateStateQuiet`). This prevents Device B from echoing back state it received from the server.
- **remoteIsPlaying tracks the server's believed state.** The controller reads `remoteIsPlaying` (updated from every STATE_SYNC) to decide whether pressing the button should send `PLAY` or `PAUSE`. Without this, the controller's stale local `isPlaying` caused it to always send the wrong command.

### Client-side code map

| File | Role |
|------|------|
| `packages/web/src/services/ws-client.ts` | Singleton WS client — connect/reconnect, device ID/name, `sendCommand`, `setActiveDevice` |
| `packages/web/src/stores/remote-playback.ts` | Zustand store — device list, `activeDeviceId`, `remoteIsPlaying`, `switchToDevice` |
| `packages/web/src/components/RemotePlaybackProvider.tsx` | Mounts once at app root; wires WS messages to the player store |
| `packages/web/src/components/DeviceSwitcher.tsx` | Popover UI for selecting the active output device |
| `packages/web/src/pages/Settings.tsx` | Remote Playback section — opt-in toggle and device rename |
| `packages/web/src/components/Player.tsx` | Conditionally drives local audio or sends remote commands |

### Server-side code map

| File | Role |
|------|------|
| `packages/api/src/services/playback-state.ts` | In-memory state + device registry; `updateState` (broadcasts) vs `updateStateQuiet` (silent) |
| `packages/api/src/services/websocket.ts` | Message handlers and broadcast listeners |
| `packages/api/src/index.ts` | `GET /api/ws/playback` route registration |

---

## Known limitations

- **State is ephemeral.** Server restart clears the active device and playback state. All devices reconnect automatically but no track is restored.
- **Shared library only.** Remote playback works because all devices stream from the same Navidrome instance using their own JWT tokens. External users on different NicotinD instances cannot be targeted.
- **One active device at a time.** Only one device receives COMMAND messages at a time. Switching to a new device pauses the previous one implicitly (the server clears `isPlaying` on active-device switch).
- **No queue sync.** The queue lives in each browser's player store. Only the currently playing track is sent via `SET_TRACK`. Advancing to the next track on the receiver plays from its local queue, which may be empty.

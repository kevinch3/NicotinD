# Remote Playback

NicotinD lets any logged-in browser tab or mobile device become a playback target. One device browses and controls; another plays the audio.

## User guide

### Enabling a device as a receiver

A device must opt in before it can receive remote commands.

1. Open **Settings** on the device you want to use as a speaker.
2. Scroll to the **Remote Playback** section.
3. Toggle **Allow remote control** on.
4. Optionally rename the device (e.g. "Living Room TV", "Phone") so it's easy to identify.

Each browser **tab** is a device: the `<audio>` element that produces sound lives in the tab, so the tab is the output. Reopening the same browser reconnects under the same name.

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

A device id is `<profileId>:<tabId>` (`resolveDeviceId`, `packages/web/src/app/lib/device-id.ts`). The profile half is minted once per browser via `crypto.randomUUID()` and persisted in `localStorage` — it survives logout and seeds the display name. The tab half lives in `sessionStorage`, so it survives a reload and an active cast is not dropped when the receiving tab refreshes, but a second tab gets its own id and is separately castable (issue #882). `profileIdOf` recovers the browser half, which is how the switcher marks a sibling tab rather than listing an anonymous twin, and how an id minted before #882 still resolves. The device name is auto-detected from the User-Agent (`"Chrome on Windows"`, `"Safari on iPhone"`, …) — except on a TV UI, where the UA reads "Chrome on Android" and says nothing a cast selector needs, so the default is `"NicotinD TV"` (issue #393) — and can be overridden by the user.

A 30-second heartbeat keeps the connection alive through idle proxies. **Any frame from a
registered connection is a liveness beat** (progress reports included), and a device that stopped
answering for `STALE_TIMEOUT` (90 s, swept every 30 s) is pruned. The server answers every
`HEARTBEAT` with `HEARTBEAT_ACK`.

#### Connection identity — one raw socket, many `WSContext`s (issue #877)

Hono's Bun adapter constructs a **new `WSContext` object for every event** (`open`, each
`message`, `close`) around the same raw Bun socket. `websocket.ts` used to key its connection table
by `WSContext`, so the key stored at `REGISTER` never matched a later event: `HEARTBEAT` never
refreshed liveness (every device was pruned 90–120 s after registering — the "unlinks after 1–2
minutes" report), `PROGRESS_REPORT` was dropped (the controller's seek bar and lyrics only ever
interpolated from the cast moment, hence the drift), `UPDATE_DEVICE` was dropped (opting out never
reached the server), and `onClose` never unregistered anything. The unit tests passed because they
reused one mock object across calls; the #433 fixes below sat behind the same lookup and never ran
in production.

The table is now keyed by the **raw socket** (`ws.raw`), and the hub keeps the REGISTER-time
context alongside, since its `send` closes over that raw socket for the socket's whole life.
`remote-playback.multi-device.test.ts` drives the real handlers with a fresh context per event, the
way the adapter does — that is the test that would have caught this.

#### Losing the active device: grace, not an instant release

When the active device's socket closes or it is pruned, the session is **not** released at once.
The device stays listed and active for `activeGraceMs` (`PlaybackStateManager`, 15 s by default);
a re-`REGISTER` within it keeps the cast and the snapshot reply re-syncs the receiver. Only if it
stays gone is `activeDeviceId` cleared. A 1-second reconnect blip is therefore invisible to the
controller instead of collapsing the session. A device that **opts out** while active
(`UPDATE_DEVICE { remoteEnabled: false }`, or re-registering as not remote-enabled) is released
immediately — a controller must never point at a device the list no longer has.

#### Surviving a prune and a stale close (issue #433)

Two defects made "the TV disappeared from the device list" **permanent** rather than transient:

- **A pruned device could never re-register.** The client only sends `REGISTER` from `ws.onopen`,
  which never fires again while the socket stays `OPEN`. Any later frame from a connection whose
  device the sweeper pruned now rebuilds it from the registration kept alongside the connection.
- **Two tabs of one browser were one device.** The id was minted per *profile*, so both tabs
  registered it and both executed every `COMMAND` — a cast to "Chrome on Linux" made sound twice.
  The id is per tab now (issue #882). "Duplicate tab" copies `sessionStorage`, so the copy would
  boot holding its original's tab id; `guardTabId` (`lib/tab-id-guard.ts`) announces the id over a
  `BroadcastChannel`, which never echoes to its sender — hearing a claim for the id you hold means
  a twin exists, and the tab that hears "taken" is the newcomer, so the original keeps its id and
  any cast pointed at it.
- **A stale close evicted a live device.** The client reuses **one stable device id across
  reconnects**; after a Wi-Fi blip the dead socket's close can land *after* the fresh socket
  re-registered. `onClose` drops the device only if no other connection for that user still holds
  the id.

#### The client side of liveness (issue #877)

`PlaybackWsService` binds every handler to *its* socket and ignores events from a socket that is no
longer the live one, so `disconnect()` neither schedules a reconnect nor counts as a failure, and
`connect()` while a socket is still `CONNECTING` (the boot-time token refresh re-runs the connect
effect within milliseconds) opens no second socket. A heartbeat still unanswered when the next one
is due means the socket is half-open — a proxy or Wi-Fi dropped the TCP path silently — and the
client closes it so the normal reconnect takes over, rather than reporting into the void until TCP
gives up minutes later. The ack also keeps a *paused* receiver's socket from being silent
upstream→client, which nginx's default 60 s `proxy_read_timeout` would otherwise close.

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
| `HEARTBEAT_ACK` | `{}` | Reply to every `HEARTBEAT` (sent to that client only) |

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
- **Exactly one output, and a link dropping never wakes a speaker.** `castTo` *yields* the
  controller's player (pauses it logically, not just the `<audio>` element), a device that stops
  being the output yields the same way, and a session ending (`activeDeviceId → null`) pauses the
  former controller explicitly — picking a track while remote re-arms `isPlaying`, so the yield at
  cast time alone was not enough. `null` is "no session", never "me": a stale server track is not
  loaded into a device that merely connected, and a `COMMAND` is ignored without a session.
- **A snapshot reply reconciles the output device.** The `STATE_SYNC` sent in reply to `REGISTER`
  (the one carrying `devices`) is the only `STATE_SYNC` that may load a track on the active device:
  a receiver that reconnects while still active adopts the server's track and position, since a
  `SET_TRACK` broadcast while it was offline reached nobody. Plain broadcasts still never execute.
- **The decisions are pure and shared.** Everything above lives in `@nicotind/core`
  `remote-playback.ts` (`reduceServerMessage`, `castTo`, `onLocalTrackChanged`, `isAudioOutput`);
  `RemotePlaybackService` feeds it signals and applies its `PlayerEffect`s to `PlayerService`. The
  api-side `remote-playback.simulation.test.ts` runs the same functions for N virtual devices
  against the real server hub, checking one invariant: while a session exists, at most one device
  is audible and it is the one the server calls active.

### Client-side code map

| File | Role |
|------|------|
| `packages/core/src/remote-playback.ts` | The client's protocol decisions, pure: `reduceServerMessage`, `castTo`, `onLocalTrackChanged`, `isAudioOutput` |
| `packages/web/src/app/services/playback-ws.service.ts` | Singleton WS service — connect/reconnect, per-socket handlers, heartbeat + ack watchdog, device ID/name, `sendCommand`, `setActiveDevice` |
| `packages/web/src/app/services/remote-playback.service.ts` | Angular adapter with signals — feeds the reducer, applies `PlayerEffect`s to `PlayerService`, `switchToDevice` |
| `packages/web/src/app/components/device-switcher/device-switcher.component.ts` | Popover UI for selecting the active output device |
| `packages/web/src/app/pages/settings/settings.component.ts` | Remote Playback section — opt-in toggle and device rename |
| `packages/web/src/app/components/player/player.component.ts` | Conditionally drives local audio or sends remote commands |

### Server-side code map

| File | Role |
|------|------|
| `packages/api/src/services/playback-state.ts` | In-memory state + device registry; `updateState` (broadcasts) vs `updateStateQuiet` (silent); `activeGraceMs` |
| `packages/api/src/services/websocket.ts` | `createPlaybackHub` — connection table keyed by raw socket, message handlers, broadcast listeners |
| `packages/api/src/services/remote-playback.multi-device.test.ts` | Server-side virtual devices: real hub + manager, a fresh `WSContext` per event |
| `packages/api/src/services/remote-playback.simulation.test.ts` | Full simulation: N virtual devices running the core reducer against the real hub |
| `packages/e2e/tests/remote-playback.spec.ts` | Two real browser contexts through the real adapter: cast, progress, opt-out, re-cast |
| `packages/api/src/index.ts` | `GET /api/ws/playback` route registration |

---

## Known limitations

- **State is ephemeral.** Server restart clears the active device and playback state. All devices reconnect automatically but no track is restored.
- **Shared library only.** Remote playback works because all devices stream from the same Navidrome instance using their own JWT tokens. External users on different NicotinD instances cannot be targeted.
- **One active device at a time.** Only one device receives COMMAND messages at a time. Switching to a new device pauses the previous one implicitly (the server clears `isPlaying` on active-device switch).
- **No queue sync.** The queue lives in each browser's player store. Only the currently playing track is sent via `SET_TRACK`. Advancing to the next track on the receiver plays from its local queue, which may be empty.

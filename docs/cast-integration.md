# Cast Integration — Chromecast & DLNA/UPnP

NicotinD can direct playback to hardware devices on the local network — Chromecast
dongles, smart TVs, AV receivers, network speakers — using a **server-side
controller** architecture. No browser-side Cast SDK, no native mobile plugins, no
Google CDN dependency. Any browser (Firefox, Safari, Chrome) can control playback
to any supported hardware device through the same REST API.

This is an extension of the existing WebSocket-based **remote playback** system
([remote-playback.md](remote-playback.md)), which lets one browser tab control
another. Cast targets appear alongside browser-tab devices in the same device
switcher UI, but the hardware device itself doesn't speak the WebSocket protocol —
the server bridges state on its behalf.

---

## Why server-side, not browser-side

The initial analysis considered the **Google Cast Web Sender SDK** (loaded from
`www.gstatic.com` in Chrome only). This was rejected for the following reasons:

1. **Chrome-only.** Firefox and Safari — common self-hoster choices — get nothing.
   The existing WS remote playback works in all browsers; a cast feature that
   only works in Chrome creates a degraded experience for a large segment of
   users.
2. **Phones home to Google.** The Cast SDK loads from gstatic.com on every page
   load even though the cast session itself is LAN-local. A self-hosted,
   privacy-conscious product shipping a Google CDN dependency is architecturally
   inconsistent, and breaks for users with network-level ad/telemetry blocking.
3. **Two divergent architectures.** Browser-side Cast + server-side DLNA would
   mean two code paths, two state sync models, two testing strategies. The
   server-side approach gives one unified controller with pluggable protocol
   adapters: it's less code, less surface area, and works in every browser.
4. **Capacitor plugins are a maintenance burden.** No maintained Capacitor Cast
   plugins exist. Building one means Swift + Kotlin code, two SDKs to track, and
   per-platform device-quirk fixes. With the server-side approach, the mobile app
   uses the same REST API as the web — zero native cast code.

### The `castv2` library

Server-side Chromecast control uses `castv2` (protocol layer) + `castv2-client`
(high-level client) — both verified working in Bun (pure JS, `node:tls` +
`protobufjs` no native modules). These are unmaintained (last published 2016 /
2019) but the CASTv2 wire protocol is stable and hasn't changed. The Default Media
Receiver (app ID `CC1AD845`) needs no Google developer registration or $5 fee.

### DLNA/UPnP hardware

Server-side DLNA control uses `node-ssdp` v4 (SSDP discovery) +
`upnp-mediarenderer-client` (AVTransport SOAP control). Both are pure JS and
verified working in Bun. `node-ssdp` v4 is the most maintained SSDP library (last
published 2020). There are no pure-TypeScript DLNA libraries in the npm ecosystem;
we vendor and pin.

---

## Architecture

```
Any browser (Firefox / Safari / Chrome / mobile)
    |
    |  REST:  GET    /api/cast/devices          -> discovered + manual devices
    |  REST:  POST   /api/cast/:deviceId/play   -> { trackId, queueIds?, format? }
    |  REST:  POST   /api/cast/:deviceId/pause
    |  REST:  POST   /api/cast/:deviceId/seek   -> { position }
    |  REST:  POST   /api/cast/:deviceId/stop
    |  REST:  GET    /api/cast/:deviceId/status -> position + state
    |  WS:    device appears in DEVICES_SYNC as type 'chromecast' | 'dlna'
    |
    v
  +----------------------------------+
  |     CastController (server)      |
  |                                  |
  |  +----------+   +-------------+  |
  |  | DLNA     |   | Chromecast   |  |
  |  | Adapter  |   | Adapter       |  |
  |  | (SSDP +  |   | (castv2 +     |  |
  |  |  UPnP)   |   |  bonjour/mDNS)|  |
  |  +----+-----+   +------+-------+  |
  |       |                |          |
  |       v                v          |
  |  DLNA renderer    Chromecast       |
  |  (fetches URL)    (fetches URL)    |
  |       |                |          |
  |       +-------+--------+          |
  |               v                   |
  |    GET /api/stream/:id            |
  |    (existing endpoint,            |
  |     + castToken branch)           |
  +----------------------------------+
```

### Protocol adapter interface

```ts
export interface CastAdapter {
  /** Discover devices of this protocol on the local network. */
  discover(): Promise<CastDevice[]>;

  /** Tell the device to start playing a media URL. */
  play(deviceId: string, url: string, metadata: TrackMetadata): Promise<void>;

  /** Pause playback on the device. */
  pause(deviceId: string): Promise<void>;

  /** Seek to position (seconds). */
  seek(deviceId: string, position: number): Promise<void>;

  /** Stop playback and release the device. */
  stop(deviceId: string): Promise<void>;

  /** Poll current playback state (position, isPlaying, duration). */
  getStatus(deviceId: string): Promise<DeviceStatus | null>;
}

export interface CastDevice {
  id: string;           // deterministic hash of ip:port or UUID
  name: string;         // friendly name from device reply
  type: 'dlna' | 'chromecast';
  ip: string;
  port?: number;
}

export interface TrackMetadata {
  title: string;
  artist: string;
  album?: string;
  coverArtUrl?: string;
  duration?: number;
}

export interface DeviceStatus {
  isPlaying: boolean;
  position: number;     // seconds
  duration: number;     // seconds
}
```

### CastController

The `CastController` is the orchestrator. It:

1. **Manages discovery** — runs an opt-in discovery loop (configurable interval,
   auto-off if multicast is unavailable). Merges discovered devices with
   manually-entered IPs into a unified device list.
2. **Manages active cast sessions** — tracks which device is currently playing
   for which user. One active cast session per user (matches the one-active-device
   model in `PlaybackStateManager`).
3. **Mints stream URLs** — builds the authenticated stream URL by minting a
   short-lived **cast token** (see below). The controller knows its own external
   address; the cast target fetches from `GET /api/stream/:id?castToken=…`.
4. **Bridges state to WebSocket** — acts as a proxy device in
   `PlaybackStateManager`: registers itself with `type: 'chromecast'` or
   `'dlna'`, reports `PROGRESS_REPORT` on behalf of the hardware (polled via
   `adapter.getStatus()` every 5s), and forwards the user's WS commands
   (`PLAY`/`PAUSE`/`SEEK`) to the adapter.
5. **Advances the queue** — when the hardware reports playback ended (position
   reaches duration, or `isPlaying` transitions to false at the end), the
   controller mints a new cast token for the next track in the queue and calls
   `adapter.play()` again.

### File layout

```
packages/api/src/
  routes/
    cast.ts                     — REST endpoints (/api/cast/*)
  services/
    cast/
      controller.ts             — CastController orchestration
      adapter.ts                — CastAdapter interface + CastDevice types
      dlna-adapter.ts            — DLNA/UPnP adapter (node-ssdp + upnp-mediarenderer-client)
      chromecast-adapter.ts      — Chromecast adapter (castv2-client + bonjour)
      cast-tokens.ts            — short-lived token minting + validation
      device-store.ts           — persistent manual device entries (SQLite)
```

---

## Cast tokens

### Problem

The existing stream endpoint authenticates via `?token=<jwt>` validated by
`authMiddleware` (`middleware/auth.ts:17`). JWTs have a 30-day sliding session
that silently renews on app boot — fine for a browser that re-fetches the token,
but a hardware device (Chromecast, DLNA renderer) holds a single URL and may
re-fetch it hours later (far seek, re-buffer after network blip). The JWT could
expire mid-session, or the user's session could end, silently breaking playback.

### Solution

A new **cast token** type: short-lived (24h), read-only, scoped to one track (or
a small queue window), stored in a `cast_tokens` SQLite table. The
`CastController` mints these server-side — it doesn't need a user JWT to do so;

it creates its own tokens.

#### Schema

```sql
CREATE TABLE IF NOT EXISTS cast_tokens (
  token     TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL,
  track_id  TEXT NOT NULL,          -- scoped to one track
  device_id TEXT NOT NULL,          -- which cast device this is for
  created_at INTEGER NOT NULL,     -- epoch ms
  expires_at INTEGER NOT NULL,     -- epoch ms (created_at + 24h)
  session_id TEXT NOT NULL          -- groups tokens in one cast session
);
```

Index on `session_id` for fast cleanup. Index on `expires_at` for expiry sweep.

#### Minting

```ts
// cast-tokens.ts
export function mintCastToken(db: Database, opts: {
  userId: string;
  trackId: string;
  deviceId: string;
  sessionId: string;
}): string {
  const token = crypto.randomUUID();
  const now = Date.now();
  db.run(
    'INSERT INTO cast_tokens (token, user_id, track_id, device_id, created_at, expires_at, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [token, opts.userId, opts.trackId, opts.deviceId, now, now + 24 * 60 * 60 * 1000, opts.sessionId],
  );
  return token;
}
```

#### Validation

The stream route's auth flow gains a `castToken` branch. When `?castToken=` is
present, validate it against the `cast_tokens` table before the JWT
`authMiddleware` runs. This means the auth middleware order changes:

```
Before:  app.use('/api/stream/*', authMiddleware)
After:   app.use('/api/stream/*', castTokenMiddleware, authMiddleware)
```

`castTokenMiddleware` checks `?castToken=`. If present and valid:
- Sets `c.set('user', { sub: row.user_id, role: 'user', cast: true })` — a
  minimal user context with a `cast: true` flag so the stream route knows this
  is a hardware fetch, not a browser request.
- Calls `next()` to skip the JWT authentication.

If `?castToken=` is absent, it just calls `next()` and the existing
`authMiddleware` validates the JWT as before.

#### Lifecycle

```
User casts Track A to device D
    |
    v
CastController:
  1. sessionId = uuid()
  2. token T1 = mintCastToken({ trackId: A, deviceId: D, sessionId })
  3. url = `${serverBaseUrl}/api/stream/${trackId}?castToken=${T1}&format=mp3&maxBitRate=192`
  4. adapter.play(D, url, metadata)
  5. poll adapter.getStatus() every 5s -> PROGRESS_REPORT to WS
  6. Track A ends -> token T2 = mintCastToken({ trackId: B, ... })
     adapter.play(D, streamUrl(B, T2), metadata)
  ...
  7. User stops -> DELETE FROM cast_tokens WHERE session_id = sessionId
```

A background sweep (runs every 10 min) deletes expired tokens:

```sql
DELETE FROM cast_tokens WHERE expires_at < ?
```

---

## REST API

All endpoints require JWT auth (`authMiddleware`). The `CastController` is
injected via route options, same as other route modules.

### `GET /api/cast/devices`

Returns discovered devices + manually-added devices.

```json
{
  "devices": [
    {
      "id": "dlna-192.168.1.50-49152",
      "name": "Living Room TV",
      "type": "dlna",
      "ip": "192.168.1.50",
      "port": 49152
    },
    {
      "id": "cc-192.168.1.100-8009",
      "name": "Chromecast",
      "type": "chromecast",
      "ip": "192.168.1.100",
      "port": 8009
    }
  ],
  "discoveryAvailable": true
}
```

`discoveryAvailable` is `false` when multicast probing failed (Docker bridge,
VPN). The UI shows a hint to add devices manually.

### `POST /api/cast/devices`

Manually add a device (for when auto-discovery is unavailable).

```json
{
  "ip": "192.168.1.50",
  "port": 49152,
  "name": "Living Room Speaker"
}
```

The controller probes the IP:port — tries CASTv2 handshake (port 8009) and UPnP
GET (port 49152+) — to classify the protocol. Persists in SQLite so it survives
restarts.

Returns the classified `CastDevice` with its generated `id`.

### `DELETE /api/cast/devices/:id`

Remove a manually-added device. Discovery-found devices are not persisted and
can't be deleted (they vanish when discovery stops finding them).

### `POST /api/cast/:deviceId/play`

```json
{
  "trackId": "abc123",
  "queueIds": ["abc123", "def456", "ghi789"],
  "format": "mp3"
}
```

- Mints a cast token for `trackId`.
- Calls `adapter.play(deviceId, streamUrl, metadata)`.
- Registers the device in `PlaybackStateManager` as the active device with
  `type: 'dlna'` or `'chromecast'`.
- Starts the status-polling interval (5s) that forwards `PROGRESS_REPORT`.

`queueIds` is optional but recommended — the controller pre-mints tokens for the
next 3 tracks so track advances are instant.

`format` defaults to `mp3` at 192 kbps for maximum device compatibility;
DLNA renderers and Chromecast both handle MP3 universally. The user can override
per-session in settings.

### `POST /api/cast/:deviceId/pause`

Calls `adapter.pause(deviceId)`. Updates `PlaybackStateManager` state
(`isPlaying: false`).

### `POST /api/cast/:deviceId/seek`

```json
{ "position": 120.5 }
```

Calls `adapter.seek(deviceId, position)`.

### `POST /api/cast/:deviceId/stop`

Calls `adapter.stop(deviceId)`. Invalidates all cast tokens for this session.
Unregisters the device from `PlaybackStateManager`.

### `GET /api/cast/:deviceId/status`

Returns the last polled status (no extra device round-trip):

```json
{
  "isPlaying": true,
  "position": 45.2,
  "duration": 213.0
}
```

---

## WebSocket integration

The existing WS protocol (`/api/ws/playback`) is unchanged — cast devices are
bridged into it by the `CastController` acting as a proxy.

### Registration

When a user casts to a device, the `CastController` calls
`PlaybackStateManager.registerDevice()` with the device's id, name, and
`type: 'dlna'` or `'chromecast'`. This triggers `DEVICES_SYNC` broadcast — all
connected browser tabs see the cast device in their device list.

### Active device

The `CastController` calls `PlaybackStateManager.updateState({ activeDeviceId: castDeviceId })`.
The browser's `DeviceSwitcherComponent` already renders the active device
highlight regardless of type — zero UI change for the active indicator.

### Progress reporting

The `CastController`'s poll interval (5s) calls `adapter.getStatus()`. When
status arrives, the controller calls
`PlaybackStateManager.updateState({ position, duration, isPlaying, timestamp })`.
This triggers a `STATE_SYNC` broadcast — all browser tabs update their seek bars.
On the browser side, `RemotePlaybackService` already handles `STATE_SYNC`
position updates via `setRemoteProgress()`. **No client-side changes needed.**

### Command relay

When a browser tab sends `SET_ACTIVE_DEVICE` or `COMMAND` messages, the
`CastController`'s WS command subscription intercepts commands targeted at the
active cast device and translates them to adapter calls:

| WS command | Adapter call |
|-----------|-------------|
| `PLAY` | `adapter.resume(deviceId)` or re-`play()` |
| `PAUSE` | `adapter.pause(deviceId)` |
| `SEEK` | `adapter.seek(deviceId, position)` |
| `SET_TRACK` | `mintCastToken()` + `adapter.play(deviceId, url, metadata)` |
| `NEXT` / `PREV` | Controller advances its queue cursor |

This interception happens in the `CastController`, which subscribes to the
`PlaybackStateManager`'s `command` event — the same event the WS layer already
listens to. The controller filters: only act on commands where
`activeDeviceId === aCastDeviceId`.

### Device type rendering

`DeviceSwitcherComponent` (`device-switcher.component.ts:14`) already branches
on `type !== 'web'` → music note emoji. Cast devices will render with the music
note (or a speaker emoji if we want to distinguish — minor UI tweak, optional).

### Unregistration

When the user stops casting (stop endpoint, or the controller's status poll
detects the device is gone), the `CastController` calls
`PlaybackStateManager.unregisterDevice(castDeviceId)`, triggering
`DEVICES_SYNC`.

---

## Discovery strategy

### The Docker multicast problem

SSDP (DLNA) and mDNS (Chromecast) use UDP multicast (239.255.255.250:1900 and
224.0.0.251:5353 respectively). Docker's default bridge network creates an
isolated L2 domain — multicast packets don't cross the bridge boundary. This
means auto-discovery silently fails for any NicotinD deployment running in
Docker, which is the common case.

### Solution: opt-in discovery + manual fallback

Discovery is **off by default**. The settings page has a toggle: "Scan for cast
devices on local network." When enabled:

1. The `CastController` does one SSDP `M-SEARCH` + one mDNS browse on startup.
2. If either finds devices, discovery stays on with a 60s refresh interval.
3. If neither finds anything (Docker bridge, no devices, firewall), the
   controller logs a warning and sets `discoveryAvailable = false`. The UI shows:
   "No devices found automatically. Add a device manually with its IP address."
4. Manual entry is **always available** regardless of discovery state. The
   controller probes the entered IP:port directly — no multicast needed.

This makes the feature work in every environment:
- **Bare metal / `--network=host` Docker:** auto-discovery works.
- **Bridge-mode Docker:** auto-discovery fails gracefully; manual IP entry works.
- **VPN / Tailscale:** same — manual entry of the remote device's IP.

### Docker deployment recommendation

The documentation will recommend `--network=host` for the API container when
cast discovery is desired. This is already common for media servers (Plex,
Jellyfin) that need SSDP/mDNS. For users who can't use host networking (Docker
Desktop on Mac/Windows, or strict isolation requirements), manual IP entry is
the supported path.

---

## Transcoding for cast devices

Cast devices have varied codec support:

| Device class | Best format | Notes |
|-------------|-------------|-------|
| Chromecast | MP3, AAC, FLAC, Opus | Default Media Receiver handles most formats |
| DLNA renderers | MP3, AAC, FLAC, WAV | Varies by device; MP3 is universal |

The `CastController` defaults to `?format=mp3&maxBitRate=192` for cast stream
URLs — maximum compatibility at a transparent bitrate for most users. This is
configurable in the Settings page ("Cast quality" dropdown: MP3 128 / MP3 192 /
MP3 320 / Original). The existing transcode pipeline
(`transcode-cache.ts`) handles this with no changes — it already caches
transcoded files on disk with Range support.

For users who want bit-perfect casting to a device that supports their file
format (e.g., Chromecast + FLAC), the "Original" option skips transcoding —
`?format=raw`.

---

## Settings page

A new **Cast** section in Settings (web UI):

```
Cast
-----
[ ] Scan for cast devices on local network          (opt-in discovery toggle)

Cast quality:    [ MP3 192kbps  v ]                  (format/bitrate dropdown)

Manual devices:
  Living Room TV    192.168.1.50:49152   [dlna]   [Remove]
  Chromecast        192.168.1.100:8009    [cc]     [Remove]
  [ + Add device by IP ]

Status: Discovery unavailable (multicast not reachable).
        Add devices manually with their IP address.
```

The discovery toggle and manual device list are per-user settings stored in
SQLite (`app_settings` table, same pattern as streaming settings).

Manual devices are persisted in a `cast_devices` table:

```sql
CREATE TABLE IF NOT EXISTS cast_devices (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name    TEXT,
  type    TEXT NOT NULL,     -- 'dlna' | 'chromecast' | 'unknown'
  ip      TEXT NOT NULL,
  port    INTEGER,
  created_at INTEGER NOT NULL
);
```

---

## Implementation phases

### Phase 1: DLNA — server-side control point

**Scope:**
- `node-ssdp` v4 for SSDP discovery (opt-in, with Docker fallback to manual IP)
- `upnp-mediarenderer-client` for AVTransport control (play/pause/seek/stop)
- REST endpoints: `/api/cast/devices`, `/api/cast/:deviceId/{play,pause,seek,stop,status}`
- `cast_tokens` table + stream endpoint auth branch for `?castToken=`
- `CastController` reports progress to `PlaybackStateManager` via
  `PROGRESS_REPORT` (bridges hardware -> WS)
- Device-switcher UI: DLNA devices appear alongside browser tabs
- Settings: Cast section with manual IP entry + auto-discovery toggle

**New files:**
- `packages/api/src/routes/cast.ts`
- `packages/api/src/services/cast/controller.ts`
- `packages/api/src/services/cast/adapter.ts`
- `packages/api/src/services/cast/dlna-adapter.ts`
- `packages/api/src/services/cast/cast-tokens.ts`
- `packages/api/src/services/cast/device-store.ts`
- `packages/api/src/middleware/cast-token.ts`

**Modified files:**
- `packages/api/src/index.ts` — mount cast routes, add `castTokenMiddleware`
  before `authMiddleware` on `/api/stream/*`
- `packages/api/src/db.ts` — `cast_tokens` + `cast_devices` table creation
- `packages/web/src/app/services/remote-playback.service.ts` — subscribe to
  cast device types in `DEVICES_SYNC` (no protocol change, just UI rendering)
- `packages/web/src/app/components/device-switcher/device-switcher.component.ts`
  — speaker emoji for cast device types (minor)
- `packages/web/src/app/pages/settings/` — new Cast section component

**Tests:**
- Unit: `cast-tokens.ts` (mint, validate, expiry sweep)
- Unit: `dlna-adapter.ts` (mock SSDP responses, verify SOAP call structure)
- Integration: mount cast routes, mock DLNA renderer fixture, assert
  play/pause/seek/stop through REST -> adapter calls
- E2e (playground only — needs hardware): mock UPnPResponder fixture +
  `data-testid` cast device selection

**Effort:** ~2 weeks

### Phase 2: Chromecast — same architecture, new adapter

**Scope:**
- `castv2` + `castv2-client` + `bonjour` (mDNS) for CASTv2 + discovery
- Default Media Receiver (app ID `CC1AD845`) — no Google developer registration
- Same REST endpoints — just `type: 'chromecast'` devices appear in the list
- Same device-switcher UI, same token flow, same WS bridge
- Zero web frontend changes (device list is protocol-agnostic)

**New files:**
- `packages/api/src/services/cast/chromecast-adapter.ts`

**Modified files:**
- `packages/api/src/services/cast/controller.ts` — register Chromecast adapter
  alongside DLNA adapter

**Tests:**
- Unit: `chromecast-adapter.ts` (mock CASTv2 handshake, verify `loadMedia`
  payload)
- Integration: mock Chromecast CASTv2 server fixture

**Effort:** ~1 week (adapter only; everything else is shared)

### Phase 3: Polish + documentation

**Scope:**
- Auto-discovery loop with multicast availability detection + graceful hint
- Docker deployment docs (`--network=host` recommendation + manual IP fallback)
- Settings page: "Cast quality" dropdown, device list management UI
- E2e fixture: mock DLNA renderer (UPnPResponder) in playground mode
- CI: cast route tests added to the existing test suite

**Effort:** ~1 week

---

## What is explicitly out of scope

| Excluded | Reason |
|----------|--------|
| Browser-side Google Cast SDK | Chrome-only, phones home to gstatic.com |
| Capacitor native Cast plugins | Mobile uses same REST API as web — zero native code |
| AirPlay sender | No viable library; Apple issues DMCA takedowns; iOS users have OS-level AirPlay |
| Miracast | Wi-Fi Direct screen mirroring, not URL-based media — wrong protocol |
| AirConnect sidecar | Adds a C binary; deployment complexity for a niche bridge |
| Cast target speaking the WS protocol directly | Hardware can't run JS; server bridges state as a proxy |

---

## Risk register

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Unmaintained `castv2-client` (2016) | Medium | Pin version, vendor if needed; CASTv2 protocol is wire-stable; `castv2` low-level layer is more recent (2019) |
| Unmaintained `upnp-mediarenderer-client` (2020) | Medium | Pin version; UPnP AVTransport is a stable standard; vendor if needed |
| Docker bridge blocks multicast | High | Opt-in discovery with manual IP fallback always available; document `--network=host` |
| Cast token expires during multi-hour session | High | 24h scoped tokens minted per-track by the controller; re-minted on track advance |
| Cast device state desync from WS state | Medium | Controller is the single source of truth for cast session state; polls hardware every 5s and writes to `PlaybackStateManager` (one-way) |
| DLNA renderer device quirks (Sony TVs, Sonos) | Low | `upnp-mediarenderer-client` handles common quirks; MP3 format avoids codec issues |
| Token table grows unbounded | Low | 10-minute expiry sweep; tokens are also invalidated on session stop |
| Discovery loop hogs CPU/IO | Low | 60s refresh interval; auto-off when no devices found; opt-in only |

---

## Dependency summary

| Package | Version | Purpose | Last publish | Bun verified |
|---------|---------|---------|-------------|-------------|
| `node-ssdp` | ^4.0.1 | SSDP discovery (DLNA) | Dec 2020 | Yes |
| `upnp-mediarenderer-client` | ^1.4.0 | UPnP AVTransport control | May 2020 | Yes (pure JS) |
| `castv2` | ^0.1.10 | CASTv2 protocol layer | Sep 2019 | Yes |
| `castv2-client` | ^1.2.0 | High-level Cast client | Dec 2016 | Yes |
| `bonjour` | ^3.5.0 | mDNS discovery (Chromecast) | — | Yes (pure JS) |

All packages are pure JavaScript with no native modules. They use `node:tls`,
`node:dgram`, `node:http`, `protobufjs`, and `xml2js` — all supported in Bun.
Type definitions do not exist for any of them; we write minimal `.d.ts` ambient
declarations for the API surface we use.
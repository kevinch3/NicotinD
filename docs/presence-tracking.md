# Presence Tracking

Admin-only, ephemeral visibility into which users are currently active on the app, how many devices they have open, and how many sessions (browser tabs / app instances) are connected.

## What it measures

| Field | Meaning | How counted |
|-------|---------|-------------|
| `isConnected` | User has at least one active session | `sessions.has(userId)` |
| `amountOfDevices` | Unique physical devices with active sessions | `count(distinct deviceId)` for that user |
| `amountOfSessions` | Active browser tabs or app instances | `count(sessions)` for that user |

**Sessions != devices**: Multiple tabs on the same browser share one `deviceId` (the `nicotind_device_id` in `localStorage` is per-origin, reused across tabs). So 3 tabs on one laptop = 1 device, 3 sessions. A phone + a laptop = 2 devices.

## Design decisions

- **In-memory only.** Presence is ephemeral, high-churn data. Writing to SQLite on every heartbeat is wasteful and creates stale-on-restart problems. The `PresenceService` holds a `Map<sessionId, Session>` that resets on server restart — which is correct, because all sessions are gone too.
- **HTTP heartbeat, not WebSocket.** Presence is admin-only visibility, not real-time UX. A 60-second HTTP POST is simpler than a persistent WS per tab, avoids a second WS connection, and is sufficient for dashboard-level accuracy (data is at most ~2 min stale).
- **Admin-only.** Non-admin users cannot read presence data for other users. The heartbeat endpoint is open to all authenticated users (they report their own presence), but the admin user list is the only consumer of the aggregated stats.
- **Client-generated tabId.** Each tab generates a UUID in `sessionStorage` so the server can distinguish multiple tabs on the same device without assigning state.

## Architecture

```
Browser Tab 1 ──┐                                ┌── Admin UI
Browser Tab 2 ──┼── POST /api/presence/heartbeat ──┤   (reads enriched user list)
Mobile App    ──┘    (every 60s when auth'd)      └── GET /api/admin/users
                           │                          (presence fields merged)
                    PresenceService
                    (in-memory Map)
                    stale cleanup every 60s
```

## Server implementation

### `PresenceService` (`packages/api/src/services/presence.ts`)

```ts
interface Session {
  userId: string;
  deviceId: string;
  tabId: string;
  lastSeen: number;   // Date.now()
}

// sessionId = `${userId}:${deviceId}:${tabId}`
const sessions = new Map<string, Session>();
```

**Methods:**

| Method | Purpose |
|--------|---------|
| `heartbeat(userId, deviceId, tabId)` | Upsert session, update `lastSeen` |
| `removeSession(sessionId)` | Delete a specific session |
| `getUserPresence(userId)` | `{ isConnected, amountOfDevices, amountOfSessions }` for one user |
| `getActiveUsers()` | `Map<userId, { isConnected, amountOfDevices, amountOfSessions }>` for all users with active sessions |

**Stale cleanup:** A `setInterval` every 60s removes sessions where `Date.now() - lastSeen > 120_000`. This handles network drops, tab kills without `onClose`, and token expiry without explicit logout.

### HTTP endpoint (`packages/api/src/routes/presence.ts`)

```
POST /api/presence/heartbeat
Auth: authMiddleware (rejects share tokens)
Body: { deviceId: string, tabId: string }
Response: 204 No Content
```

The endpoint is lightweight — upsert into the in-memory Map, return immediately.

### Admin API enrichment (`packages/api/src/routes/admin.ts`)

`GET /api/admin/users` merges presence data from `PresenceService.getActiveUsers()` into each user row returned from SQLite:

```ts
{
  id: string,
  username: string,
  role: string,
  status: string,
  created_at: string,
  // added by presence merge:
  isConnected: boolean,
  amountOfDevices: number,
  amountOfSessions: number
}
```

Users with no active sessions get `isConnected: false, amountOfDevices: 0, amountOfSessions: 0`.

## Client implementation

### `PresenceService` (`packages/web/src/app/services/presence.service.ts`)

Angular injectable service:

- On app init, if `auth.isAuthenticated()`: start a 60s `setInterval` that calls `POST /api/presence/heartbeat` with `{ deviceId, tabId }`.
- `deviceId` is read from existing `localStorage.getItem('nicotind_device_id')` — same device identity as the playback WS, which is correct (same physical device).
- `tabId` is generated once per tab in `sessionStorage` via `crypto.randomUUID()` (with the same fallback as `PlaybackWsService`).
- Fires an immediate heartbeat on start (don't wait 60s for first report).
- Stops the interval on `auth.logout()`.

### Types (`packages/web/src/app/services/api/api-types.ts`)

```ts
export interface AdminUser {
  id: string;
  username: string;
  role: string;
  status: string;
  created_at: string;
  isConnected: boolean;
  amountOfDevices: number;
  amountOfSessions: number;
}
```

### Admin UI (`packages/web/src/app/pages/admin/admin.component.html`)

Add three columns after "Status" in the user table:

| Column | Render |
|--------|--------|
| Online | Green dot if `isConnected`, grey dot otherwise |
| Devices | Count (e.g. `2`) |
| Sessions | Count (e.g. `3`) |

All three columns hidden on mobile (`hidden sm:table-cell`) to keep the table compact.

## Edge cases

| Scenario | Behavior |
|----------|----------|
| Tab closed normally | No more heartbeats → stale cleanup evicts after 120s |
| Network drop (laptop lid, wifi loss) | Same — no heartbeat → stale cleanup |
| Server restart | All sessions gone (in-memory) — correct, they are |
| Same browser, 3 tabs | Same `deviceId`, different `tabId` → 1 device, 3 sessions |
| Phone + laptop | Different `deviceId`s → 2 devices, 2 sessions |
| JWT expires | Client stops sending heartbeats (auth interceptor logs out) → stale cleanup |
| Share token user | Blocked by `authMiddleware` (share tokens can't POST) |
| User disabled mid-session | Next heartbeat hits auth middleware → 403 → client stops |

## Why not WebSocket

The existing playback WS (`GET /api/ws/playback`) only connects when remote playback is enabled. Extending it to always-connect for presence would couple two unrelated concerns and force a persistent WS on every tab even when the user doesn't care about remote playback. A 60s HTTP POST is:

- **Simpler**: no WS upgrade, no reconnection logic, no second persistent connection per tab.
- **Sufficient**: admin dashboards don't need sub-second accuracy. 2-min staleness is fine.
- **Lower resource**: one request per minute per tab vs. a persistent socket + heartbeat frames.

## Server-side code map

| File | Role |
|------|------|
| `packages/api/src/services/presence.ts` | In-memory session registry + stale cleanup |
| `packages/api/src/routes/presence.ts` | `POST /api/presence/heartbeat` endpoint |
| `packages/api/src/routes/admin.ts` | Enriches `GET /api/admin/users` with presence fields |
| `packages/api/src/index.ts` | Route registration |

## Client-side code map

| File | Role |
|------|------|
| `packages/web/src/app/services/presence.service.ts` | Heartbeat interval, deviceId/tabId management |
| `packages/web/src/app/services/api/api-types.ts` | `AdminUser` type with presence fields |
| `packages/web/src/app/pages/admin/admin.component.ts` | Reads enriched user data |
| `packages/web/src/app/pages/admin/admin.component.html` | Online / Devices / Sessions columns |

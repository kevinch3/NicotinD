# Presence Tracking

Admin-only, ephemeral visibility into which users are currently active on the app, how many devices they have open, and how many sessions (browser tabs / app instances) are connected.

## What it measures

| Field | Meaning | How counted |
|-------|---------|-------------|
| `isConnected` | User has at least one active session | `sessions.has(userId)` |
| `amountOfDevices` | Unique physical devices with active sessions | `count(distinct deviceId)` for that user |
| `amountOfSessions` | Active browser tabs or app instances | `count(sessions)` for that user |

**Sessions != devices**: Multiple tabs on the same browser share one `deviceId` — presence reports the *profile* half of the playback device id (`profileIdOf`), which is the `nicotind_device_id` in `localStorage` and is reused across tabs. So 3 tabs on one laptop = 1 device, 3 sessions. A phone + a laptop = 2 devices. Remote playback deliberately counts the other way: there a device is the *output*, which is the tab (#882).

## Design decisions

- **In-memory only — for live session state.** Presence is ephemeral, high-churn data. Writing session state to SQLite on every heartbeat is wasteful and creates stale-on-restart problems. The `PresenceService` holds a `Map<sessionId, Session>` that resets on server restart — which is correct, because all sessions are gone too. The **derived** `users.last_seen_at` timestamp *is* persisted; see [Persisted last-seen vs ephemeral presence](#persisted-last-seen-vs-ephemeral-presence) for why that is not a contradiction.
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

The endpoint is lightweight — upsert into the in-memory Map, then a throttled `users.last_seen_at` stamp (see below), return immediately.

## Persisted last-seen vs ephemeral presence

`users.last_seen_at` (epoch ms, nullable, added by `addColumnIfMissing`) is the one piece of presence-adjacent data that **is** written to SQLite. It is not a walking-back of the in-memory decision above — the two answer different questions:

| | Presence (`PresenceService`) | `users.last_seen_at` |
|---|---|---|
| Question | *Who is connected right now?* | *When was this account last used?* |
| Scope | A fact about the current process | A fact about history |
| On restart | Correctly reset — the sessions are gone too | Must survive, or every user reads "never" after each deploy |

Persisting session state would be stale-on-restart. Persisting the derived timestamp is the only way to be correct at all: before it existed, an admin could see that a user was offline but never *how long* they had been gone, which is the actual question asked about a dormant account. Nothing else in the schema could answer it — `paired_devices.last_seen_at` only covers QR-paired devices, `play_events` is gated behind history consent, `audit_log` never records a plain listener, and JWTs are stateless with no sessions table.

**The original cost objection is answered by throttling, not ignored.** `services/user-last-seen.ts` memoizes the last write per user and skips the `UPDATE` entirely inside `LAST_SEEN_THROTTLE_MS` (5 minutes), so a user with six tabs open across two devices produces **at most one write per five minutes**, not six per minute. The common path stays a Map upsert.

Three write sites, via `touchLastSeen`:

| Site | Mode | Why |
|---|---|---|
| `POST /api/presence/heartbeat` | throttled | The fidelity signal — a tab open for days keeps it fresh |
| `POST /api/auth/login` | **forced** | A login is a discrete, rare, password-gated event; the exact moment is the point |
| `POST /api/auth/refresh` | throttled | Covers clients that authenticate without running the web presence service |

Two details that are load-bearing:

- **It is best-effort and never blocks the caller**, the same contract as `agent_tokens.last_used_at` — a telemetry write must not be able to fail a login or a heartbeat. The route passes `getDatabase` **unresolved** (a thunk) precisely because resolving it is itself a throwing operation: calling it at the call site would put that throw *outside* `touchLastSeen`'s catch, turning a 204 heartbeat into a 500.
- **A failed write does not enter the throttle map**, so a transient error retries on the next beat rather than suppressing writes for the whole window.

There is deliberately **no backfill**: "joined" is not "last seen", and there is no historical source to derive it from. `NULL` renders as "Never".

`last_seen_at` is personal data and is included in the Art. 15 export (`exportUserData`) — note that the `users` row there is projected by an explicit `SELECT`, not the `PRAGMA table_info` loop used for `USER_TABLES`, so a new `users` column must be added to it by hand. It is operational metadata rather than listening history, so the `NICOTIND_HISTORY` consent chain does not gate it.

### Admin API enrichment (`packages/api/src/routes/admin.ts`)

`GET /api/admin/users` merges presence data from `PresenceService.getActiveUsers()` into each user row returned from SQLite:

```ts
{
  id: string,
  username: string,
  role: string,
  status: string,
  created_at: string,
  last_seen_at: number | null,  // persisted; null = never connected
  // added by presence merge:
  isConnected: boolean,
  amountOfDevices: number,
  amountOfSessions: number
}
```

Users with no active sessions get `isConnected: false, amountOfDevices: 0, amountOfSessions: 0`.

**Ordering** is `compareUsersByActivity`: online first → `last_seen_at` DESC (NULLs *last*, because NULL is "unknown", not "infinitely long ago") → `created_at` ASC. It runs in JS **after** the presence merge, not in SQL, because `isConnected` is not a column — SQL cannot express the primary key of this ordering. The query's `ORDER BY created_at ASC` is now only the stable base the comparator falls through to.

## Client implementation

### `PresenceService` (`packages/web/src/app/services/presence.service.ts`)

Angular injectable service (owns lifecycle only — the actual HTTP call lives on `SystemApiService.postHeartbeat()`, per this repo's per-domain `services/api/*` convention):

- `initialize()` is called once from the root `App` constructor (same pattern as `RemotePlaybackService.initialize()`). It runs an `effect(() => …)` on `auth.token()`: while authenticated, fire an immediate heartbeat then start a 60s `setInterval`; when the token clears (logout / 401), the interval is cleared.
- `deviceId` is read from `PlaybackWsService.getDeviceId()` (which persists `nicotind_device_id` in `localStorage`) — same device identity as the playback WS, which is correct (same physical device).
- `tabId` is generated once per tab in `sessionStorage` under the key `nicotind_tab_id` via `crypto.randomUUID()`. It comes from the shared `resolveTabId` (`packages/web/src/app/lib/device-id.ts`) — the same helper the playback device id's tab half uses, so the heartbeat and the cast target can never name different tabs. It used to be a private copy in `PresenceService` reading that same key (#882).
- Heartbeat errors are swallowed (best-effort); the auth interceptor already handles 401/403 logout.

### Types (`packages/web/src/app/services/api/api-types.ts`)

```ts
export interface AdminUser {
  id: string;
  username: string;
  role: string;
  status: string;
  created_at: string;
  last_seen_at: number | null;
  isConnected: boolean;
  amountOfDevices: number;
  amountOfSessions: number;
}
```

### Admin UI (`packages/web/src/app/pages/admin/admin.component.html`)

The user table is **five columns, none of them hidden at any viewport**:

| Column | Render |
|--------|--------|
| User | Username + `(you)`, with `Joined <date>` as a muted second line |
| Role | The role control itself — a `MenuPanelComponent` picker styled as the badge (`user-role-trigger` / `user-role-option-<role>`); your own row renders a non-interactive badge (`user-role-static`) |
| Status | `active` / `disabled` dot + label |
| Activity | Dot + `Online` and a muted `N devices · N sessions`, or the relative last connection (`Never` when `last_seen_at` is null), absolute time in the `title` |
| ⋯ | `user-actions-toggle` opening Disable/Enable, Reset password, Delete |

It previously had eight columns, four of which (Online / Devices / Sessions / Joined) were `hidden sm:table-cell`. That was wrong in practice: on a phone the admin lost exactly the data they had come to look at. **The principle is consolidate, not hide** — Devices/Sessions became the muted second line of Activity, and Joined the muted second line of User, so a ~360 px viewport shows everything without horizontal scroll.

Two structural constraints worth knowing before editing this table:

- The D-pad group is one `axis="vertical"` `appTvNavGroup` on a wrapper `<div>` (`data-testid="users-table"`), **never** on `<table>`/`<tr>`/`<td>`: `TvNavGroupDirective` force-sets `role="toolbar"` via a host binding, which would clobber the table's implicit ARIA roles. Items register by DI, so they are still found across `<td>` and component boundaries.
- **No `appTvNavGroup` inside a `[menuPanel]`.** `MenuPanelComponent` already owns ArrowUp/Down there and stops propagation (issue #389); a nested group double-moves focus on every press.

Role and status render through `admin.role.*` / `admin.status.*` keys rather than the raw server string, which is what the rest of the page does.

## Edge cases

| Scenario | Behavior |
|----------|----------|
| Tab closed normally | No more heartbeats → stale cleanup evicts after 120s |
| Network drop (laptop lid, wifi loss) | Same — no heartbeat → stale cleanup |
| Server restart | All sessions gone (in-memory) — correct, they are. `last_seen_at` survives, which is the point of persisting it |
| Never connected | `last_seen_at IS NULL` → "Never". Deliberately not backfilled from `created_at` |
| DB unavailable on a heartbeat | The stamp is skipped silently; the heartbeat still returns 204 |
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
| `packages/api/src/services/user-last-seen.ts` | `touchLastSeen` — throttled, best-effort `users.last_seen_at` stamp |
| `packages/api/src/routes/presence.ts` | `POST /api/presence/heartbeat` endpoint (+ throttled stamp) |
| `packages/api/src/routes/auth.ts` | Stamps on login (forced) and refresh (throttled) |
| `packages/api/src/routes/admin.ts` | Enriches `GET /api/admin/users`; owns `compareUsersByActivity` |
| `packages/api/src/db.ts` | `users.last_seen_at` additive migration |
| `packages/api/src/index.ts` | Route registration |

## Client-side code map

| File | Role |
|------|------|
| `packages/web/src/app/services/presence.service.ts` | Heartbeat interval (token-gated `effect`), deviceId/tabId management |
| `packages/web/src/app/services/api/system-api.service.ts` | `postHeartbeat()` → `POST /api/presence/heartbeat` |
| `packages/web/src/app/app.ts` | Calls `presence.initialize()` once at bootstrap |
| `packages/web/src/app/services/api/api-types.ts` | `AdminUser` type with presence + `last_seen_at` |
| `packages/web/src/app/lib/user-activity.ts` | `userActivityLabel` / `userActivityDetail` — the Activity cell's logic, pure so it is testable below e2e |
| `packages/web/src/app/lib/relative-time.ts` | `timeAgo` — the shared relative-time helper |
| `packages/web/src/app/pages/admin/admin.component.ts` | Reads enriched user data; role picker + ⋯ menu handlers |
| `packages/web/src/app/pages/admin/admin.component.html` | The five-column users table |

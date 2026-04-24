# Share Links for Playlists and Albums

**Date:** 2026-04-24
**Status:** Approved

## Context

NicotinD users want to share a playlist or album with someone who doesn't have an account. The shared view must be rich (cover art, tracklist, audio playback) but strictly read-only and time-limited to avoid exposing the full library to unauthenticated parties. The link activates a 5-minute session the moment the recipient first opens it.

## Approach: Token → Ephemeral JWT

A share token is generated server-side and stored in the database. It is inert until the first visit. On first access, the server records `first_accessed_at`, sets `expires_at = first_accessed_at + 300s`, and returns a standard 5-minute JWT. The frontend stores this JWT in memory (sessionStorage) and uses it for all resource requests — cover art, metadata, and audio streaming — through the existing API endpoints unchanged. The JWT carries a `share: true` claim; the auth middleware rejects any non-GET request carrying that claim, enforcing read-only access automatically.

---

## Data Model

New table added to `packages/api/src/db.ts`:

```sql
CREATE TABLE share_tokens (
  token             TEXT    PRIMARY KEY,
  resource_type     TEXT    NOT NULL CHECK (resource_type IN ('playlist', 'album')),
  resource_id       TEXT    NOT NULL,
  created_by        TEXT    NOT NULL REFERENCES users(id),
  created_at        INTEGER NOT NULL,
  first_accessed_at INTEGER,
  expires_at        INTEGER
);
```

Token format: `crypto.randomBytes(16).toString('base64url')` — 22-character URL-safe string.

`first_accessed_at` and `expires_at` are NULL until the first visit. This means a link sitting in an inbox does not expire — the 5-minute clock starts only on first open.

---

## API Endpoints

### `POST /api/share` — Generate share link
- **Auth:** required (existing `authMiddleware`)
- **Body:** `{ resourceType: 'playlist' | 'album', resourceId: string }`
- **Response:** `{ url: string }` — full absolute URL e.g. `http://host/share/<token>`
- Inserts a row into `share_tokens`; returns immediately

### `POST /api/share/activate/:token` — Activate and get ephemeral JWT
- **Auth:** none (public route)
- **First call:** sets `first_accessed_at = now_ms`, `expires_at = now_ms + 300_000` (both stored as Unix milliseconds); mints and returns a JWT with `exp = expires_at / 1000` (Unix seconds, as the JWT spec requires)
- **Subsequent calls within window:** re-issues a JWT using the stored `expires_at` — `exp` is always `expires_at / 1000`, not recalculated from the current time (so no sliding-window extension)
- **Missing token:** `404 Not Found`
- **Expired token** (`expires_at` is set and in the past): `410 Gone`
- **Response:** `{ jwt: string, resourceType: 'playlist' | 'album', resourceId: string }`

### JWT payload for share sessions
```json
{
  "sub": "<creator-user-id>",
  "share": true,
  "scope": "read",
  "exp": <first_accessed_at_unix_s + 300>
}
```

---

## Auth Middleware Change

**File:** `packages/api/src/middleware/auth.ts`

After verifying the JWT, add:
```typescript
if (payload.share === true && c.req.method !== 'GET') {
  return c.json({ error: 'Share sessions are read-only' }, 403);
}
```

This single guard makes every existing endpoint (stream, cover, library, playlists) automatically read-only for share JWTs — no per-route changes needed.

---

## Angular Share Page

### Route
Added to `packages/web/src/app/app.routes.ts` **outside** the auth-protected layout:
```typescript
{ path: 'share/:token', component: ShareViewComponent }
```
No `authGuard`.

### `ShareSessionService` (`packages/web/src/app/services/share-session.service.ts`)
- `shareJwt = signal<string | null>(null)`
- `activate(token)` — calls `POST /api/share/activate/:token`, stores JWT in the signal only (in-memory). No sessionStorage persistence — on page reload, `ShareViewComponent` simply calls `activate` again using the token still present in the URL (activate is idempotent within the window).

### `ShareViewComponent` (`packages/web/src/app/pages/share/share-view.component.ts`)
Lifecycle:
1. Read `:token` from route params
2. Call `ShareSessionService.activate(token)` — get JWT + resourceType + resourceId
3. Use `HttpClient` with manual `{ headers: { Authorization: 'Bearer <shareJwt>' } }` to load the resource
4. Render the share page

HTTP for streaming/cover: URLs constructed as `/api/stream/:id?token=<shareJwt>` and `/api/cover/:id?token=<shareJwt>` — the backend already accepts `?token=` for both.

### UI States
| State | Display |
|-------|---------|
| `loading` | Spinner centered on page |
| `active` | Cover art + tracklist + mini player |
| `expired` | "This share link has expired" with NicotinD branding |

### Share Page Layout (active state)
- **Cover art:** large square, disc-styled (CSS `border-radius: 8px`, box shadow, subtle vinyl ring via `::after`) — uses `/api/cover/:id?token=<shareJwt>` or deterministic gradient fallback
- **Header:** resource title (bold), artist name or playlist owner below (muted)
- **Track list:** scrollable table — `#` · title · artist · duration; clicking a row plays that track
- **Mini player bar** (bottom, fixed): current track name · ◀ prev · ▷/⏸ play-pause · ▶ next · seek bar · volume
- The mini player owns a `<audio>` element via `viewChild()` — fully independent of `PlayerService`
- **Footer:** "Powered by NicotinD" (links to the app's login page)

### OpenGraph Meta Tags
`ShareViewComponent` uses Angular's `Meta` and `Title` services to set:
- `og:title`, `og:description`, `og:image` (cover art URL with token), `og:type` set to `music.album` for albums and `music.playlist` for playlists
  
Client-side only — sufficient for Slack previews; Discord/Telegram require SSR (out of scope).

---

## Share Button UX

Added to two existing components:

**Album detail** (`packages/web/src/app/pages/library/album-detail.component.ts/.html`):
- Share icon button in the header toolbar alongside the Play button

**Playlist detail** (`packages/web/src/app/pages/playlists/playlists.component.ts/.html`):
- Share icon button in the detail view toolbar

**On click:**
1. `POST /api/share` with `{ resourceType, resourceId }`
2. `navigator.clipboard.writeText(url)`
3. Inline toast: _"Link copied — expires 5 min after first open"_ (auto-dismisses in 3s)

---

## Files to Create

| File | Purpose |
|------|---------|
| `packages/api/src/routes/share.ts` | Two API routes: generate + activate |
| `packages/web/src/app/services/share-session.service.ts` | Share JWT storage signal |
| `packages/web/src/app/pages/share/share-view.component.ts` | Share page component |
| `packages/web/src/app/pages/share/share-view.component.html` | Share page template |

## Files to Modify

| File | Change |
|------|--------|
| `packages/api/src/db.ts` | Add `share_tokens` table creation |
| `packages/api/src/index.ts` | Register `share.ts` routes; exempt `/api/share/activate/*` from auth |
| `packages/api/src/middleware/auth.ts` | Reject non-GET for `share: true` JWTs |
| `packages/web/src/app/app.routes.ts` | Add `/share/:token` route outside auth group |
| `packages/web/src/app/pages/library/album-detail.component.ts/.html` | Share button |
| `packages/web/src/app/pages/playlists/playlists.component.ts/.html` | Share button |

---

## Verification

1. **Generate a link:** Log in, open an album or playlist, click Share → toast appears, URL is in clipboard
2. **Open in incognito:** Paste URL → share page loads with cover art, tracklist, and audio playback
3. **Expiry:** Wait 5 min after first open → API returns 401 → page shows expired state
4. **Replay protection:** Opening the share URL a second time within the window → re-issues JWT with same exp (not a new 5 min window)
5. **Write-block:** In DevTools, send `POST /api/playlists` with the share JWT → expect `403 Share sessions are read-only`
6. **Expired link from the start:** Call `POST /api/share/activate/:token` with a token whose `expires_at` is in the past → `410 Gone`

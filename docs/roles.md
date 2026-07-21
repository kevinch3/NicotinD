# User roles (capability ladder)

NicotinD has four user roles forming a **strict ascending capability ladder** — each tier is a
superset of the one below it. Roles are stored in `users.role` (a plain `TEXT` column, no CHECK
constraint) and carried on the JWT (`JwtPayload.role`). The first registered user becomes `admin`;
new self-registrations default to `user`; an admin assigns the other roles from user management.

```
listener  <  user  <  refiner  <  admin
```

| Capability | listener | user | refiner | admin |
|---|:--:|:--:|:--:|:--:|
| Play library, search **library**, own playlists, cast | ✅ | ✅ | ✅ | ✅ |
| **Acquire** — hunt/download/URL, Downloads feed, network search results | ❌ | ✅ | ✅ | ✅ |
| **Curate** — album edit/merge/delete, metadata & cover overrides, artist-identity, genre, lyrics | ❌ | ❌ | ✅ | ✅ |
| **Server admin** — user mgmt, streaming/processing settings, find-dupes, `/sync`, extensions config | ❌ | ❌ | ❌ | ✅ |

**Why this shape.** The driver was decluttering: some users have no interest in acquisition and
want a clean, Spotify-style listening app. `listener` is that experience — acquisition is *hidden
and enforced server-side*, not merely hidden in the UI. `refiner` is a bonus delegation tier: it
lets a trusted user curate the library without handing them full server administration. Existing
`user` accounts are unchanged by the migration (they keep exactly today's powers), so nothing
breaks on upgrade — there is no data migration, only new valid values.

## Single source of truth

`packages/core/src/roles.ts` defines the ladder and the capability predicates, shared by the API
guards and the web gating (mirrored into the web via `packages/web/src/types/core.ts`):

- `canAcquire(role)` — `>= user` (anyone but a listener)
- `canCurate(role)`  — `>= refiner`
- `isAdmin(role)`    — `=== admin`
- `asRole(str)`      — coerce an unknown/legacy value to a valid `Role`, defaulting to `user`
  (never *elevating* a garbage value).

## Server-side enforcement

Three guards in `packages/api/src/middleware/current-user.ts` (all throw `ForbiddenError` → 403):

- `requireAcquirer(c)` — mounted as a group-level `app.use('*', …)` on every acquisition router:
  `acquire`, `discography` (hunt), `watchlist`, `downloads`, `archive`, `spotify`.
- `requireCurator(c)` — replaces `requireAdmin` on the ~20 curation routes in `library.ts`
  (album delete/hide/reclassify/metadata/cover, artist image, `artists/identity`, `songs/:id/genre`,
  `songs/:id/lyrics`, `songs/:id` delete, `bulk-delete`).
- `requireAdmin(c)` — unchanged; still gates `routes/admin.ts` **and** the three server-ops left in
  `library.ts`: `POST /sync` (rescan), `GET /untracked`, `GET /duplicates` (heavier/diagnostic, not
  curation).

**Search is the one exception** (filter, not 403): `GET /api/search` must still return **library**
results for a listener, so it only *suppresses the network fan-out* when `!canAcquire(role)` — the
library provider always runs; the slskd/plugin providers are skipped.

The admin role-update route (`PUT /api/admin/users/:id/role`) validates the incoming role against
the four-value `ROLES` set.

## Role-change propagation

A role change must reach the user without waiting for them to happen to log in again (a demotion
that doesn't revoke access promptly would be a security gap). The JWT carries the role, so:

- `POST /api/auth/refresh` **re-reads the role from the DB** when it mints the sliding-session
  token (it no longer copies the old token's role). On every app boot the web calls `refresh` →
  `getMe`, then `AuthService.setRole(profile.role)` updates the cached role. Net effect: an admin's
  change takes effect on the user's **next load**, not only on a full re-login.
- Missing/disabled accounts are already bounced by `authMiddleware` (403) before `refresh` runs, so
  a disable also takes effect on next request.

`packages/e2e/tests/roles.spec.ts` proves the whole loop end-to-end: a fresh `user` sees Downloads;
an admin demotes them to `listener` via the role `<select>`; after the user reloads, Downloads is
gone from their nav and `/downloads` bounces to the radio landing.

## Web gating

`AuthService` exposes `canAcquire()` / `canCurate()` / `isAdmin()` computeds (off the `role`
signal). UI surfaces gate on these:

- **Acquisition hidden from listeners** (`canAcquire()`): the Downloads nav item (desktop
  `layout.component` + mobile `bottom-nav`), the `/downloads` route (`acquireGuard`), and the search
  page's acquisition surfaces (source-availability pill, link-intent/URL card, catalog hunt cards,
  blended "Get" results, the Advanced network lane) — the library results list stays visible.
- **Curation gated to refiner+admin** (`canCurate()`): the `⋯` Remove action
  (`song-menu.service`), album/artist/genre/library-songs delete + edit controls, and the
  track-info sheet's artist-identity / genre / lyrics editors.
- **Admin unchanged** (`isAdmin()`): the Admin nav link/routes, Extensions, and admin-only
  Settings sections. User management uses a four-value role `<select>`.

## Audit log (admin)

With refiners, destructive actions are multi-user — the `audit_log` table gives admins a durable
"who did what, when" record instead of grepping server logs (`services/audit-log.ts`).
`recordAudit` is called **explicitly at the mutation sites** with meaningful action names — not a
blanket mutation middleware, which would drown the log in per-listener noise (stars, lyric edits).
Instrumented today: `album.delete`, `songs.bulk-delete`, `artist.identity` (rename/merge/split
detail), and the admin user-management routes (`user.create/role/status/password-reset/delete`).
A failed ledger write never breaks the audited action. `GET /api/admin/audit?limit=&offset=`
(admin-gated) serves entries newest-first; the Admin page renders the recent 50 as an "Audit log"
table (`data-testid="audit-log"`). Add new destructive routes to the ledger when you add them.

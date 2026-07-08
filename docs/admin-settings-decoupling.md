# Admin / Settings / Extensions decoupling

## Why

The core **Settings** page had grown into a grab-bag: universal user preferences (theme, offline
storage, remote playback) sat next to server-admin tools (streaming, library-processing window,
find-duplicates) and, worse, **slskd-extension** config (Soulseek creds, listening port, shared
folders) — all gated only by `isAdmin()`. That coupled the core product to one specific extension
and blurred three different audiences (a user tweaking prefs, an admin operating the server, an admin
configuring an extension). This refactor draws clean lines.

## Target structure

| Surface | Route | Audience | Contents |
| --- | --- | --- | --- |
| **Settings** | `/settings` | every user | Appearance, Offline storage, Remote playback + device name, Account (sign-out/version/changelog), iOS Now-Playing diagnostics. **Nothing admin- or extension-specific.** Admins also get `Admin →` + `Extensions →` links. |
| **Admin** | `/admin` (`adminGuard`) | admins | User management, System (services/restart, scan, optimize-metadata, logs), **Streaming**, **Library processing**, **Library maintenance: find-duplicates**, Incomplete albums, Untracked downloads. |
| **Extensions** | `/settings/plugins` (`adminGuard`) | admins | The plugin hub (enable/disable/consent + generic `configFields`). Extensions with bespoke settings link to their own page. |
| **slskd extension** | `/settings/plugins/slskd` (`adminGuard`) | admins | Connection (creds/port/UPnP + connect/disconnect), Shared folders, and a live **status panel**. Body gated on `PluginService.hasSlskd()`. |

## What moved (UI only)

- **Settings → Admin**: `streaming-panel`, `processing-panel` (incl. its SSE stream to
  `/api/admin/processing/stream`), `duplicates-panel`. Handlers were lifted verbatim onto
  `AdminComponent` (they already called `SystemApiService`/`LibraryApiService`). The processing
  `EventSource` is opened in `ngOnInit` and closed in `ngOnDestroy` alongside the existing log
  stream.
- **Settings → slskd extension page**: the Soulseek connection form + shared-folders manager, moved
  verbatim onto `SlskdSettingsComponent`.

**Backend storage is unchanged.** slskd credentials still live in `secrets.json` behind the
admin-gated `/api/settings/soulseek*` and `/api/settings/shares*` routes (wired to embedded-mode via
`slskd-config.ts`). We deliberately relocated the *UI* only — migrating creds into the `plugins`
table's `config_json` would touch the embedded-mode credential wiring and need a data migration, for
no user-visible gain. If that migration is ever wanted, it's the "purer ownership" alternative noted
in the plan.

## slskd status panel (Nicotine+-inspired)

`GET /api/plugins/slskd/status` → typed `SlskdStatus` (`@nicotind/core`). Admin-only (via the
`/:id/*` guard in `routes/plugins.ts`); self-gates on the plugin being enabled and a client being
reachable, returning a zeroed shell otherwise.

| Field | Source |
| --- | --- |
| current up/down speed (B/s) | sum of in-progress `averageSpeed` over `transfers.getDownloads/Uploads()` |
| downloading / uploading / queued counts | same transfer groups, bucketed by state |
| upload/download speed limit + slots | `options.get()` JSON, via defensive `extractSlskdLimits` |
| shared files/directories, version, uptime | `application.getInfo()` |
| connection (state/username/isConnected) | `application.getInfo().server` ?? `server.getState()` |

Roll-up is pure + unit-tested in `services/slskd-status.ts` (`buildSlskdStatus`,
`sumInProgressSpeed`, `computeCounts`, `extractSlskdLimits`). Each slskd probe is fetched
independently so one failing call degrades to zeros rather than 500ing the panel. The frontend
(`SlskdSettingsComponent`) polls every ~3s while the tab is visible.

> The limit extractor is best-effort: slskd's `/api/v0/options` JSON keys have varied across
> versions, so `extractSlskdLimits` probes both `global.upload/download.*` and `uploads/downloads.*`
> shapes and renders "—" for anything unresolved. Speed limits are KiB/s; `0` = unlimited. **Editing**
> limits is out of scope (they live in slskd's own `slskd.yml`); this panel is read-only.

## Decoupling audit (other pages)

Extension-specific UI already gates on `PluginService` capabilities server- and client-side (search
network lane, URL acquire box, watchlist star, Spotify/archive lanes). The onboarding wizard's
Soulseek step is optional and now points users to **Settings → Extensions** for later config. No
page hard-errors when slskd is off.

## Follow-up ideas (quick wins / low-hanging)

Small, independent improvements this refactor sets up — none required for it to ship:

1. **Editable slskd limits** — add a write path (`options.updateYaml` / a slskd options PUT) so the
   status panel's speed limits + upload slots become editable inline instead of read-only. The
   status endpoint + types already model them.
2. **Reuse the status panel on Admin's System card** — the slskd System tile in Admin still shows
   only healthy/connected; it could surface live up/down speed from the same `SlskdStatus` for an
   at-a-glance server view.
3. **Per-transfer detail in the panel** — the roll-up already walks every transfer; a small expandable
   list (filename · peer · speed · % ) would mirror Nicotine+'s transfer view with no new API.
4. **Generalize `PLUGIN_DETAIL_ROUTES` to a manifest flag** — let a plugin declare
   `hasSettingsPage` in its manifest so the Configure link is data-driven instead of a hardcoded
   frontend map (removes the one place the kernel still knows an extension by id).
5. **Extensions surface for `metadata`/`connectivity` kinds** — the lrclib lyrics plugin and the
   scaffolded connectivity kind could each get a small settings page via the same detail-route
   pattern.
6. **Library maintenance consolidation** — Admin now hosts find-duplicates next to incomplete-albums
   and untracked-downloads; folding the library-audit scripts (`docs/library-audit.md`) behind a
   button here would give admins one maintenance home.
7. **User-facing "what's shared" read-out** — surface the slskd share stats (files/folders) to
   non-admins as a lightweight "you're sharing N tracks" acknowledgement, reinforcing the P2P
   give/take model.

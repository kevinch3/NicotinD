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
| **Extensions** | `/settings/plugins` (`adminGuard`) | admins | The plugin hub — three collapsible kind-group cards (Acquisition/Metadata/Connectivity), each holding a collapsible per-plugin card (enable/disable/consent + generic `configFields`). Extensions with bespoke settings (slskd) embed them inline in their own card body instead of linking to a separate page (Task 4, settings-cards unification). |

> **slskd's settings used to live at `/settings/plugins/slskd`** — that route now just redirects
> back to `/settings/plugins`. `SlskdSettingsComponent` (connection creds/port/UPnP +
> connect/disconnect, shared folders, and a live **status panel**) is unchanged internally but is
> now rendered inline inside `PluginCardComponent`'s collapsible body (`@if (plugin.id === 'slskd')`)
> instead of behind its own route, stripped of its former page chrome (container/back-link/`<h1>` —
> the card supplies that). Its body is gated on `PluginService.hasSlskd()` as before. Because the
> card body is itself `@if`-gated on being expanded, `SlskdSettingsComponent` — and its ~3s status
> poll started in `ngOnInit` — only mounts while the card is open; collapsing it runs `ngOnDestroy`
> and stops the poll.

## What moved (UI only)

- **Settings → Admin**: `streaming-panel`, `processing-panel` (incl. its SSE stream to
  `/api/admin/processing/stream`), `duplicates-panel`. Handlers were lifted verbatim onto
  `AdminComponent` (they already called `SystemApiService`/`LibraryApiService`). The processing
  `EventSource` is opened in `ngOnInit` and closed in `ngOnDestroy` alongside the existing log
  stream.
- **Settings → slskd extension card**: the Soulseek connection form + shared-folders manager, moved
  verbatim onto `SlskdSettingsComponent`, now embedded inline in the slskd `PluginCardComponent`'s
  collapsible body rather than behind its own route (Task 4, settings-cards unification).

> **Superseded (phase 4).** The in-process slskd plugin described below was removed when slskd
> became an external addon — the `/api/settings/soulseek*` / `/api/settings/shares*` routes and
> `slskd-config.ts` no longer exist in this repo. slskd credentials now live on the addon container
> (`SLSKD_ADDON_*`), not in core `secrets.json`. The historical notes below are kept for context.
> See [acquisition-addon-protocol.md](acquisition-addon-protocol.md).

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
4. ~~**Generalize `PLUGIN_DETAIL_ROUTES` to a manifest flag**~~ — **Superseded.** Task 4 (settings-cards
   unification) removed per-plugin detail routes entirely: a plugin with bespoke settings (slskd)
   now embeds them inline in its own collapsible `PluginCardComponent` body instead of linking
   elsewhere, so there is no longer a route map to generalize. A future second bespoke-settings
   plugin would follow the same `@if (plugin.id === '…')` pattern in the card template.
5. **Extensions surface for `metadata`/`connectivity` kinds** — the lrclib lyrics plugin and the
   scaffolded connectivity kind could each get bespoke settings via the same inline collapsible
   card-body pattern slskd now uses.
6. ~~**Library maintenance consolidation**~~ — **Shipped.** The Admin page (previously one flat
   1530-line scroll with a 14-panel "System" mega-section holding unrelated sub-panels with no
   internal grouping) was regrouped into **8 collapsible, icon-headed groups**: System Health,
   Library Processing, Library Maintenance, Streaming & Media, Backups & Data, Acquisition &
   Automation, User Management, Audit Log. The shared `SettingsGroupComponent`
   (`packages/web/src/app/components/settings-group/`, generalized from the Admin-only
   `AdminGroupComponent` as part of the settings-cards unification — see
   [docs/design-patterns.md](design-patterns.md) "SettingsGroupComponent") composes
   `SettingsGroupHeaderComponent`'s icon+title+description header with a collapsible body,
   persisted per-device to `localStorage` (key `nicotind-group-<groupId>`, cleared on signout).
   Every group is collapsed by default.

   **Each group is now its own panel component** under `pages/admin/<groupId>/`, so
   `admin.component.html` is an ordered list of tags and reordering a section is a one-line move
   (guarded by "renders the panels in the intended order" in `admin.component.spec.ts` — the
   previous count-only assertion could not see order at all). The `<app-settings-group>` wrapper
   lives *inside* each panel, which keeps the `groupId` literal beside the markup it labels: that
   string is both the `localStorage` key above and the e2e selector (`helpers.ts` resolves
   `[data-group-id]`), so a mismatch would silently reset everyone's collapse state and break the
   e2e lane. `host: { class: 'contents' }` keeps the panel's host box out of the layout.

   Panels inject `ServiceReviewService` directly rather than receiving inputs — it is root-provided
   with a refcounted `start()`/`stop()` and a coalescing `refresh()`, so N panels still share one
   5 s poll and one request, and a signal `input()` on a nested imported component never lands in
   this repo's JIT vitest harness (`testing/signal-input.ts`). `AdminComponent` keeps exactly one
   job: owning that poll's lifecycle. The one piece of state two sections share — the acquisition
   kill-switch, written by Acquisition & Automation and read by Library Processing for the
   hold-for-review warning (#416) — moved to a root `AcquisitionSettingsService` for the same
   reason.

   The default order is **User Management first, then Library Processing**, ahead of System Health.
   "Library
   Maintenance" now holds: orphan rows, the fragmentation diagnostic, sync/rescan library,
   optimize-metadata, artist-image coverage, find-duplicates, incomplete albums, and untracked
   downloads — folding library-audit-adjacent tooling into one maintenance home, as this idea
   proposed. Zero backend changes. Folding the standalone `docs/library-audit.md` scripts behind a
   button here remains a further, un-scheduled follow-up.
7. **User-facing "what's shared" read-out** — surface the slskd share stats (files/folders) to
   non-admins as a lightweight "you're sharing N tracks" acknowledgement, reinforcing the P2P
   give/take model.

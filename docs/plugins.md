# Plugin architecture

NicotinD's acquisition (and, later, connectivity) capabilities are factored into **opt-in
plugins** behind a small kind-agnostic kernel. The goal is decoupling + a clean compliance
posture: the core product (library + streaming) runs with **zero acquisition enabled**, and
acquisition is an affirmative, admin-gated, consent-recorded opt-in (legality varies by country).

> Status: **Phases A–D landed.** A = SDK contracts, registry, persistence, management API.
> B = the **slskd acquisition plugin** + gating of network search / downloads / browse / hunt /
> watchlist. C = the **yt-dlp + spotdl URL-acquisition plugins** (`resolve`) + registry URL
> routing. D = **default-off for fresh installs** + the **web management UI** (Settings → Plugins)
>
> - capability-gating of the web surfaces. Connectivity (Phase E) is **scaffolded but not shipped**
>   — the kernel + UI handle the kind generically; no connectivity plugin is registered yet.

## Layering

```
Plugin SDK (@nicotind/core, src/plugin/*)      ← stable capability + manifest contracts
        ▲ implements
First-party plugins (packages/api/src/services/plugins/<id>/)   ← slskd, ytdlp, spotdl (later phases)
        ▲ registered at build time
PluginRegistry (services/plugins/registry.ts)  ← enable/disable/consent/config + capability resolution
        ▲ drives
Host orchestrators (search route, album hunt, /api/acquire) + Settings → Plugins UI
```

A generic **kernel** (manifest, enable/disable, config, consent, health, lifecycle) is
kind-agnostic; each **kind** (`acquisition` now, `connectivity` scaffolded) defines its own
capability contracts. New kinds add contracts without touching the kernel.

## Contracts — `packages/core/src/plugin/`

- **`manifest.ts`** — `PluginManifest` (id, name, kind, declared `capabilities`, optional zod
  `configSchema`, `requirements.binaries`, `compliance` disclaimer + `requiresConsent`,
  `defaultEnabled`). `validatePluginManifest()` enforces id format and kind/capability coherence
  (acquisition plugins may not be `defaultEnabled`). `PluginInfo` is the serializable UI view.
- **`capabilities.ts`** — `SearchCapability`, `BrowseCapability`, `ResolveCapability`,
  `DownloadCapability`, `ConnectivityCapability`. A plugin exposes exactly the accessors its
  manifest declares. `SearchCapability` mirrors the legacy `ISearchProvider` so existing providers
  satisfy it unchanged.
- **`context.ts`** — `PluginHostContext`: the **only** surface a plugin may use to affect the
  system (scoped logger, resolved config, `allocStagingDir(jobId)`, `emitProgress(jobId, …)`,
  scoped `storage`). A plugin **cannot** touch the library DB or the organizer. It produces files
  in a staging dir; the host owns ingest (`organize → scan → enrich`). This boundary is the
  decoupling guarantee and the safety story.
- **`index.ts`** — the `Plugin` interface (`init` / `isAvailable` / `dispose` + capability
  accessors) and re-exports.

## Kernel — `packages/api/src/services/plugins/`

- **`registry.ts`** (`PluginRegistry`) — holds build-time-registered plugins, persists
  enable/consent/config in the `plugins` table, and resolves plugins by kind/capability/URL for
  the host. `enable(id, user)` initializes the plugin with a host context and records consent when
  the manifest requires it; `disable(id)` disposes it. `initEnabled()` re-initializes
  persisted-enabled plugins at boot. Acquisition plugins are **dormant** (expose no capability)
  until enabled.
- **`host-context.ts`** — builds the `PluginHostContext`: staging under
  `<dataDir>/staging/plugins/<id>/<jobId>`, a `plugin_kv`-backed scoped store, and a progress
  emitter the host wires to its job tables.

### Persistence (`packages/api/src/db.ts`)

- `plugins(id PK, enabled, config_json, consent_at, consent_user)` — one row per known plugin;
  absent row ⇒ never enabled (default-off).
- `plugin_kv(plugin_id, key, value)` — per-plugin scoped kv (the `storage` surface).

## Management API — `packages/api/src/routes/plugins.ts`

- `GET /api/plugins` — `PluginInfo[]` for **any** authenticated user (drives the capability-gated
  UI: clients show/hide acquisition surfaces based on what's enabled).
- `POST /api/plugins/:id/enable` — **admin-only**. For a consent-gated plugin the body must carry
  `{ consent: true }`, else `412` with the manifest's `disclaimer`. Records the acting admin.
- `POST /api/plugins/:id/disable` — admin-only.
- `PUT /api/plugins/:id/config` — admin-only; validates the body against the manifest's
  `configSchema` (`400` on failure).

## First-party plugins

- **slskd** (`services/plugins/slskd/index.ts`) — acquisition plugin (`search·browse·download`,
  consent-gated) wrapping the Soulseek client. It owns a single `SlskdSearchProvider` and
  **(de)registers it in the legacy `ProviderRegistry` on `init`/`dispose`** — so the unified-search
  network lane, the downloads enqueue route, and user-browse all light up only while the plugin is
  enabled, with **no changes to those routes**. Its `isAvailable()` reflects `slskdRef.current`.
  The richer **album-hunt / fallback / retry / watchlist** engine still uses the slskd client
  directly; instead of rewiring it, those features are **request-gated** by
  `requireAcquisitionMiddleware` (`services/plugins/gate.ts`, 503 when no enabled plugin has the
  `download` capability) on `/api/discography/*` + `/api/watchlist/*`, and the watchlist poller
  skips its sweep via the injected `isAcquisitionEnabled` predicate. Generalizing the engine onto
  capability interfaces is deferred (the seam exists; the payoff is a second searchable source).
- **yt-dlp** (`services/plugins/ytdlp/index.ts`) + **spotdl** (`services/plugins/spotdl/index.ts`)
  — URL-acquisition plugins (`resolve`, consent-gated). Each declares `canHandle(url)` (spotdl =
  `*.spotify.com`, yt-dlp = everything else), `requirements.binaries`, and a config schema. Their
  `resolve(url, jobId)` stages files via the **shared process runner** (`services/plugins/acquire/
process.ts` — `runAcquireProcess` + progress parsing + audio collection; the injectable `spawn`
  keeps it testable without process-global mocks) and **returns the staged absolute paths**. The
  host (`AcquireWatcher`) owns the `acquire_jobs` records + ingest (organize → scan → enrich) and
  routes each URL via `registry.getEnabledForUrl(url)` — there is no more `detectBackend` enum
  switch. `acquire_jobs.backend` is now an open plugin id (the legacy `CHECK IN ('ytdlp','spotdl')`
  is rebuilt away by a `db.ts` migration).
- **archive.org** (`services/plugins/archive/index.ts`) — a third URL-acquisition plugin
  (`resolve`, consent-gated) but **pure JS**: `requirements.binaries: []`, no shared process runner.
  `canHandle(url)` matches any `archive.org` item URL (`/details`, `/download`, `/compress`,
  `/metadata`, …); `resolve(url, jobId)` reads the item's `https://archive.org/metadata/<id>` file
  list, picks one audio format via `selectArchiveFiles` (config `preferredFormats`, default
  `['MP3','FLAC']` — MP3 first to save space, FLAC fallback; never mixes a FLAC original with its
  derived MP3s), and **streams** each chosen file (`https://archive.org/download/<id>/<name>`) into
  `<creator>/<title>/` under the staging dir, emitting per-file progress. `fetch` + the streaming
  `downloadFile` are constructor-injected so tests run without network or node-builtin mocks. It is
  **not** seeded by `seedLegacyAcquisitionPlugins`, so it is default-off for every install.
  Its read-only search lane (`ArchiveSearchService` + `routes/archive.ts`,
  `GET /api/archive/search`) is gated specifically on `plugins.isEnabled('archive')` (so it works as
  an independent fallback even when slskd is off) and surfaces in the album-hunt modal + unified
  search → see [docs/album-hunt.md](album-hunt.md).
- **Back-compat seeding**: before plugins existed, slskd was active whenever credentials were set,
  and yt-dlp/spotdl whenever enabled in config. `PluginRegistry.seedEnabled(id, …)` (called from
  `index.ts`, `ON CONFLICT DO NOTHING`) keeps existing installs working; an admin's later toggle
  wins. Phase D will flip the default for fresh installs.

## How to add a plugin

1. Implement `Plugin` in `packages/api/src/services/plugins/<id>/`, declaring a manifest (kind +
   capabilities + compliance/requirements) and only the capability accessors it provides.
2. `registry.register(new MyPlugin(...))` in `packages/api/src/index.ts`.
3. Host orchestrators automatically pick it up via `registry.getEnabledWithCapability(...)` /
   `getEnabledForUrl(...)` once an admin enables it.
4. Add tests (manifest validity, capability behavior) and a doc bullet. The plugin's UI (toggle,
   disclaimer, config form) is rendered generically from the manifest.

## Web UI — Settings → Plugins (`packages/web/src/app`)

- `services/plugin.service.ts` — Angular signal service over `/api/plugins`: a `plugins` signal,
  `enable(id, consent)` / `disable` / `saveConfig`, and the capability computeds `hasSearch` /
  `hasResolve` / `hasDownload` (derived from **enabled** plugins). UI surfaces gate on these.
- `pages/plugins/plugins.component.ts` — admin-only page (route `/settings/plugins`, `adminGuard`),
  linked from Settings → Plugins. Cards grouped by kind (**Acquisition** + a generic
  **Connectivity** section that currently shows an empty-state — the wiring is ready for a
  tailscale/wireguard plugin to appear with no UI changes). Enabling a consent-gated plugin opens
  its disclaimer via `ConfirmDialogComponent` and only then calls `enable(id, true)`.
- **Capability-gated surfaces**: the search page hides the **URL acquire box** unless `hasResolve()`
  and the **watchlist star** unless `hasDownload()`. The network search lane already self-hides via
  the server's `networkAvailable: false` (no enabled `search` plugin), and hunt/watchlist routes
  503 server-side — so the UI degrades to streaming-only when acquisition is off.

## Compliance posture

- **Fresh installs are default-off** (streaming-only): no acquisition plugin is enabled, so search
  shows no network lane, the URL acquire box is hidden, and hunt/watchlist are inert until an admin
  opts in. **Existing (pre-plugin) installs are migrated once** — `seedLegacyAcquisitionPlugins`
  (`services/plugins/legacy-seed.ts`) seeds the previously-implicit plugins enabled on the first
  plugin-model boot **only when users already exist**, guarded by a one-time `app_settings`
  marker so a fresh install is never retroactively auto-enabled.
- Enabling an acquisition plugin is admin-only and records consent (user + timestamp) when the
  manifest demands it. Disable is immediate and disposes the plugin.

## Roadmap (subsequent phases)

- **B** _(done)_ — slskd acquisition plugin (`search·browse·download`); network search / downloads
  / browse gate via the plugin's `ProviderRegistry` (de)registration; hunt + watchlist gate via
  `requireAcquisitionMiddleware` + the poller's `isAcquisitionEnabled`. (Full engine generalization
  onto capability interfaces deferred — see slskd note above.)
- **C** _(done)_ — yt-dlp + spotdl `resolve` plugins on a shared process runner; `AcquireWatcher`
  routes URLs via `registry.getEnabledForUrl()` (no `detectBackend`); submit 503s when none is
  enabled/available; `acquire_jobs.backend` relaxed to an open plugin id.
- **D** _(done)_ — default-off for fresh installs (one-time migration for existing installs) +
  Settings → Plugins management UI + capability-gating of the web surfaces.
- **E** _(scaffolded, not shipped)_ — connectivity kind (tailscale/wireguard). The contracts,
  registry, and UI handle the kind generically; a real connectivity plugin can be registered in
  `index.ts` with no further wiring. Per current direction, none is integrated yet.
- **Later** — extract contracts to a standalone `@nicotind/plugin-sdk` and add a dynamic/3rd-party
  loader (the contracts are designed to outlive that change).

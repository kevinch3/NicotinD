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
>   The `auth` kind (OAuth — Google + Microsoft) is **proposed, not yet implemented**; see
>   [oauth-auth.md](oauth-auth.md).

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
kind-agnostic; each **kind** (`acquisition`, `metadata` [lyrics], `connectivity` scaffolded,
`auth` [**proposed** for OAuth — not yet implemented](oauth-auth.md)) defines its own capability contracts. New kinds
add contracts without touching the kernel — the `metadata` kind (added for lyrics) is the
worked example.

## Contracts — `packages/core/src/plugin/`

- **`manifest.ts`** — `PluginManifest` (id, name, kind, declared `capabilities`, optional zod
  `configSchema`, `requirements.binaries`, `compliance` disclaimer + `requiresConsent`,
  `defaultEnabled`). `validatePluginManifest()` enforces id format and kind/capability coherence
  (acquisition plugins may not be `defaultEnabled`). `PluginInfo` is the serializable UI view.
- **`capabilities.ts`** — `SearchCapability`, `BrowseCapability`, `ResolveCapability`,
  `DownloadCapability`, `ConnectivityCapability`. A plugin exposes exactly the accessors its
  manifest declares. `SearchCapability` mirrors the legacy `ISearchProvider` so existing providers
  satisfy it unchanged. An **`OAuthCapability`** (`getAuthorizationUrl`/`exchangeCode`) is
  **proposed** for the `auth` kind — not yet implemented; see [oauth-auth.md](oauth-auth.md).
- **`context.ts`** — `PluginHostContext`: the **only** surface a plugin may use to affect the
  system (scoped logger, resolved config, `allocStagingDir(jobId)`, `emitProgress(jobId, …)`,
  `emitLabel(jobId, label)`, `emitTrack(jobId, {title, status})`, scoped `storage`). A plugin
  **cannot** touch the library DB or the organizer. It produces files in a staging dir; the host
  owns ingest (`organize → scan → enrich`). This boundary is the decoupling guarantee and the
  safety story.
  - **`emitTrack`** upserts one track's `{title, status: TrackStatus}` into `acquire_jobs.tracks_json`
    by title match (update in place, not append-and-duplicate) — the DB-facing merge is the pure
    `upsertTrackStatus` in `host-context.ts`, wrapped by a SELECT/UPDATE in `index.ts`'s
    `createPluginHostContext` wiring (mirrors `emitLabel`'s pattern). Unlike `emitLabel` (single-shot
    per job, gated by a `labelEmitted` flag in `runAcquireProcess`), `emitTrack` fires **once per
    track, many times per job** — infra landed in the schema/types/host-context/shared parsers only;
    no plugin calls it yet (spotdl/yt-dlp/archive wiring is a follow-up). The shared parsing lives in
    `acquire/process.ts`: `parseSpotdlTrackEvent` (Downloaded/Skipping → done/skipped),
    `parseYtdlpTrackEvent` (`TRACK_START::`/`TRACK_DONE::` marker lines a future yt-dlp wrapper will
    emit), and `RunAcquireOptions.onTrack` in `runAcquireProcess`'s `onData` loop, kept as a separate
    non-single-shot callback from `onLabel`.
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
- **`builtin.ts`** (`registerBuiltinPlugins`) — constructs + registers every first-party plugin in
  one covered function, called from `createApp`. It exists because **a plugin's construction
  arguments are load-bearing and were previously untestable**: `SpotdlPlugin` needs the
  `PluginRegistry` handed to it to read the spotify card's credentials live, that argument was
  silently omitted at the call site, and every unit test still passed — the documented `SPOTIPY_*`
  forwarding was dead code for the whole time. `builtin.test.ts` now asserts against the instances
  the real registration builds. Watch the two same-named registries: `PluginRegistry` (the plugin
  kernel) vs `ProviderRegistry` (the acquisition provider list slskd registers into) — their
  proximity in the original call site is what made the omission easy to miss.

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
  `configSchema` (`400` on failure). When the plugin is enabled and initialized, the registry
  **re-initializes it** (dispose → init with the merged config, serialized via an internal chain +
  `flushReinit()` awaited by the route) so the change takes effect live — previously the running
  instance kept its init-time config until a disable/enable cycle or restart.

## Remote addons (acquisition addon protocol, phase 0)

An admin can register an **out-of-process** acquisition addon by URL + bearer token
(`POST /api/plugins/addons`, admin-only, audit-logged; `DELETE /api/plugins/addons/:id`
removes it). The full protocol + phased migration lives in
[acquisition-addon-protocol.md](acquisition-addon-protocol.md) — the summary:

- `services/addons/manager.ts` fetches the addon's manifest through `AddonClient`, validates
  it (`validateAddonManifest` in `@nicotind/core` `types/addon.ts` — the builtin manifest
  rules plus a same-major protocol-version check), persists the registration + a manifest
  snapshot in `addon_registrations`, and registers a `RemoteAddonPlugin` in the live
  registry.
- `RemoteAddonPlugin` implements the ordinary `Plugin` interface, so **everything in this
  document applies unchanged**: the addon is default-off, consent-gated when its manifest
  says so, listed by `GET /api/plugins`, enabled/disabled/configured through the same
  routes, and rendered by the same card. `Plugin.origin` / `PluginInfo.remote`+`addonUrl`
  are the only additions. Config is core-owned and pushed down (`PUT /addon/v1/config`) on
  every (re-)init; `isAvailable()` follows `GET /addon/v1/health`.
- At boot, `loadRegisteredAddons` re-registers every persisted addon **from its manifest
  snapshot with no network** — a down addon still renders its card and simply reports
  unavailable. Invalid/colliding rows are skipped with a warning, never fatal.
- The registration's bearer token is stored **plaintext** — it is an *outbound* credential
  that must be replayed on every call (unlike `agent_tokens`, which only verifies inbound
  and can store a hash). Same credential class as the Soulseek password.
- `GET /api/plugins/:id/addon-status` (admin) proxies the addon's typed status rows to the
  generic `AddonStatusPanelComponent`; a down addon degrades to `{available:false}`.

### Curated marketplace (issue #517, PR1)

Registering an addon by hand is an ops chore (edit compose + `*_ADDON_TOKEN`, `up --profile`,
copy the token, paste URL+token). The **"Available add-ons"** section on Extensions removes the
discovery half now, and later PRs remove the token copy-paste entirely.

- `packages/core/src/addon-catalog.ts` holds the **curated, in-repo** list `ADDON_CATALOG`
  (slskd / ytdlp / spotdl / archive) — deliberately a short vetted list, **not** an open/
  user-submitted registry, so the compliance posture stays curated + consent-gated. Each entry's
  `id` **must equal** the addon manifest id it registers as (that equality drives the install-state
  diff). Images/ports/profiles mirror `docker-compose.yml` — keep them in sync.
- Pure, browser-safe helpers shared by the API route and the web card: `renderComposeSnippet(entry,
  token)` emits the paste-able compose block (the addon service + its pot-provider companion for
  ytdlp/spotdl) with the token baked in, and `catalogInstallState(entry, registrations)` diffs the
  catalog against the live registrations → `builtin | installed | pending | available`.
- `GET /api/plugins/catalog` (any authed user, like `GET /`) serves the entries + each one's install
  state. The web `AddonCatalogService` + `AddonCatalogCardComponent` render the admin-only section.

**One-click install (PR2).** "Install" removes the token copy-paste entirely:

- `POST /api/plugins/catalog/:id/install` (admin, audited) mints an opaque token (`mintAddonToken`,
  `randomBytes`), writes a **`pending`** `addon_registrations` row (new `status` + `catalog_id`
  columns, additive via `addColumnIfMissing`) with a catalog **stub** manifest, and returns the
  compose snippet with the token already baked in. Idempotent: re-installing while pending returns
  the *same* token (so a re-click can't rotate it mid-paste); an already-`active` id 409s. The stored
  url is the **catalog's** `addonUrl` (client input ignored) — no new SSRF surface.
- `promotePendingAddons(registry, db)` fetches each pending addon's live manifest; only if its id
  matches the pending row **and** it validates + negotiates a usable capability does it flip the row
  to `active` (real manifest) and register the plugin (disabled — enabling stays the consent step).
  An unreachable/mismatched addon stays pending and is retried. It runs on a 60s `main.ts` interval,
  on every `GET /catalog` (so opening Extensions auto-detects), and on demand via
  `POST /catalog/:id/check` ("Check now"). `loadRegisteredAddons` skips pending rows at boot.
- The card walks Install → paste snippet + `up` → **Pending** (polls) → **Installed → Enable**
  (delegated to the page's existing consent dialog via `enableRequested`). Zero new privilege: no
  Docker socket, curated urls only, token plaintext like every registration token.

## First-party plugins

> **Superseded (phase 4).** The in-process **slskd** plugin below (and its
> `services/plugins/slskd/*`, `buildSlskdDefinition`/`slskd.yml` regeneration, `slskd-config.ts`,
> and `/api/settings/soulseek*`/`shares*` routes) was **removed** when slskd became an external,
> Torrentio-style addon in its own repo. Core now registers slskd by URL as a remote addon (see the
> `RemoteAddonPlugin` section above and [acquisition-addon-protocol.md](acquisition-addon-protocol.md)).
> The slskd notes below are retained for historical context only.

- **slskd** (`services/plugins/slskd/index.ts`) — acquisition plugin (`search·browse·download`,
  consent-gated) wrapping the Soulseek client. It owns a single `SlskdSearchProvider` and
  **(de)registers it in the legacy `ProviderRegistry` on `init`/`dispose`** — so the unified-search
  network lane, the downloads enqueue route, and user-browse all light up only while the plugin is
  enabled, with **no changes to those routes**. Its `isAvailable()` reflects `slskdRef.current`.
  **Auto-shared music dir (embedded mode):** `buildSlskdDefinition`
  (`packages/service-manager/src/services/slskd.ts`) seeds `shares.directories: [musicDir]` into
  the generated `slskd.yml` whenever no shares are configured — a fresh install shares its library
  out of the box (Soulseek etiquette; many peers refuse no-share leechers, which quietly degrades
  search results). Regeneration **merges** with the existing `slskd.yml` rather than replacing it:
  slskd's own remote-config API writes user-added shares into that same file, so NicotinD owns only
  its managed keys (`soulseek`/`directories`/`web`/default share) and preserves everything else. An
  emptied shares list re-seeds the default on next boot.
  The richer **album-hunt / fallback / retry / watchlist** engine still uses the slskd client
  directly; instead of rewiring it, those features are **request-gated** by
  `requireAcquisitionMiddleware` (`services/plugins/gate.ts`, 503 when no enabled plugin has the
  `download` capability) on `/api/discography/*` + `/api/watchlist/*`, and the watchlist poller
  skips its sweep via the injected `isAcquisitionEnabled` predicate. Generalizing the engine onto
  capability interfaces is deferred (the seam exists; the payoff is a second searchable source).
- **~~yt-dlp / spotdl~~ (both left core)** — the two URL-acquisition plugins are now **external
  addons** (`nicotind-ytdlp-addon` = the `^https?://` catch-all; `nicotind-spotdl-addon` =
  `spotify.com`), registered under Extensions → Add addon. There is **no in-process resolve plugin
  left**; archive.org is a bundled addon. The description below is the historical in-process shape,
  kept for the shared-process-runner design it documents. The old plugins declared
  `canHandle(url)`, `requirements.binaries`, and a config schema. Their
  `resolve(url, jobId)` stages files via the **shared process runner** (`services/plugins/acquire/
process.ts` — `runAcquireProcess` + progress parsing + audio collection; the injectable `spawn`
  keeps it testable without process-global mocks) and **returns the staged absolute paths**. The
  host (`AcquireWatcher`) owns the `acquire_jobs` records + ingest (organize → scan → enrich) and
  routes each URL via `registry.getEnabledForUrl(url)` — there is no more `detectBackend` enum
  switch. `acquire_jobs.backend` is now an open plugin id (the legacy `CHECK IN ('ytdlp','spotdl')`
  is rebuilt away by a `db.ts` migration).

  **Binary discovery (`acquireEnv`, `process.ts`):** every probe (`isBinaryAvailable`) and spawn
  (`runAcquireProcess`) runs with an augmented environment — PATH is prepended with the dir of
  `NICOTIND_FFMPEG_PATH` (so the desktop app's bundled ffmpeg is what yt-dlp/spotdl find for
  post-processing, even with no system ffmpeg), then `/opt/homebrew/bin`, `/usr/local/bin`, and
  `~/.local/bin`. Rationale: a GUI-launched Electron app inherits a minimal PATH (macOS apps get
  `/usr/bin:/bin:...` without Homebrew; Linux launchers often miss `~/.local/bin`) — exactly where
  brew/pip install these tools — so without this, an installed yt-dlp shows "not found" on
  desktop. Both plugins also expose **`binaryPath` as an admin-editable config field**
  (`configFields`) for anything the augmented PATH still misses. `isBinaryAvailable`'s
  per-path cache is **invalidated on plugin (re)init** (`invalidateBinaryCache`), so a binary
  installed or a path reconfigured while the app runs is re-probed instead of staying
  "unavailable" for the process lifetime.

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
- **spotify** (`services/plugins/spotify/index.ts`) — a **metadata-only** acquisition plugin
  (capability `search`, pure JS, **no `resolve`/`download`**, no binary). It backs the Spotify
  **fallback search lane** (`SpotifySearchService` + `routes/spotify.ts`, `GET /api/spotify/search`,
  gated on `plugins.isEnabled('spotify')`) but downloads nothing itself — the lane hands a matched
  album's `open.spotify.com` URL to `/api/acquire`, where the **spotdl** `resolve` plugin acquires it
  (so the full flow needs both plugins). The plugin holds the Spotify app **client id/secret** via a
  `configSchema` + `configFields` (the secret is a write-only `password`); `isAvailable()` is true
  only when enabled **and** both creds are set. It declares `search` purely for honesty — nothing
  consumes the generic `hasSearch`; the lane gates on the id-specific `hasSpotify`. **Not** seeded by
  `seedLegacyAcquisitionPlugins`, so default-off for every install. → see
  [docs/spotify-fallback.md](spotify-fallback.md).
- **lrclib** (`services/plugins/lrclib/index.ts`) — the first **`metadata`-kind** plugin (capability
  `lyrics`, pure JS, no binary, no key). It introduced the metadata kind + the `LyricsCapability`
  contract (`fetchLyrics(LyricsQuery) → LyricsResult|null`); `validatePluginManifest` now allows
  `lyrics` for `metadata` and **scopes the `defaultEnabled:true` ban to `acquisition` only**, so this
  benign source **default-enables**. It queries LRCLIB's `/api/get` (exact artist+title+album+duration
  match) and falls back to `/api/search`, returning both plain and synced (LRC) lyrics; `fetchFn` is
  constructor-injected for tests. Registered in `index.ts` and **seeded enabled on first boot** via
  `seedEnabled('lrclib', 'system')` (idempotent — an admin's later disable wins). The host (lyrics
  routes in `routes/library.ts`) owns persistence (`library_lyrics` side-table + file-tag write-back)
  and the user-edit/`customized` protection — the plugin only resolves text. → see the "Lyrics"
  bullet in [CLAUDE.md](../CLAUDE.md).
- **discogs** (`services/plugins/discogs/`) — a **`metadata`-kind** plugin (capability `genre`),
  **default-off + consent-gated** (Discogs API ToU). The **shell**: manifest + HTTP client (auth,
  on-disk cache, 55/min token-bucket rate limiter) + pure matching primitives + a `GenreCapability`
  (`fetchGenres(GenreQuery) → GenreResult|null`), registered so it's manageable in Extensions. **No
  enrichment task consumes it yet** — wiring it into the windowed processor + `library_genre_overrides`
  write path is deferred to the per-capability issue, gated by the #191 coverage spike. Auth is a
  free **Consumer Key + Secret** (60/min, image rights, shared — not a per-user token); the admin
  registers an app at `discogs.com/settings/developers`. `client.ts`/`matching.ts` follow the
  Lrclib/MusicBrainz injected-deps posture (`fetchFn`, `clock`/`sleep`) so tests need no network.
  → **canonical reference: [docs/discogs-plugin.md](discogs-plugin.md).**
- **oauth-google** + **oauth-microsoft** (`services/plugins/oauth-google/index.ts`,
  `services/plugins/oauth-microsoft/index.ts`) — **proposed `auth`-kind** plugins (capability
  `oauth`), **not yet implemented.** Each wraps its provider's authorize/token/userinfo endpoints,
  holds the OAuth client id/secret via a `configSchema` + `configFields` (the secret is a write-only
  `password` — same masking pattern as the Spotify plugin), and exposes
  `OAuthCapability.getAuthorizationUrl(state, redirectUri)` /
  `exchangeCode(code, redirectUri)`. The `redirectUri` is derived at call time from
  `NICOTIND_PUBLIC_URL` (or `http://localhost:${port}` fallback) so one plugin serves dev, prod,
  and mobile. Auto-enabled on first boot when env-set creds are present (`seedEnabled`,
  idempotent — admin can disable later). Pure JS (no binary), `fetchFn` constructor-injected
  for tests. The host (`routes/oauth.ts`, also proposed) owns the user lookup/create + JWT sign +
  the `/api/auth/{providers,oauth/:provider,callback/:provider,dev-login}` public routes. → see
  [docs/oauth-auth.md](oauth-auth.md).
- **Back-compat seeding**: before plugins existed, slskd was active whenever credentials were set,
  and yt-dlp/spotdl whenever enabled in config. `PluginRegistry.seedEnabled(id, …)` (called from
  `index.ts`, `ON CONFLICT DO NOTHING`) keeps existing installs working; an admin's later toggle
  wins. Phase D will flip the default for fresh installs.

## How to add a plugin

1. Implement `Plugin` in `packages/api/src/services/plugins/<id>/`, declaring a manifest (kind +
   capabilities + compliance/requirements) and only the capability accessors it provides.
2. `plugins.register(new MyPlugin(...))` in `registerBuiltinPlugins`
   (`packages/api/src/services/plugins/builtin.ts`) — **not** inline in `index.ts`, so the
   construction (including any cross-plugin dependency) is covered by `builtin.test.ts`.
3. Host orchestrators automatically pick it up via `registry.getEnabledWithCapability(...)` /
   `getEnabledForUrl(...)` once an admin enables it.
4. Add tests (manifest validity, capability behavior) and a doc bullet. The plugin's UI (toggle,
   disclaimer, config form) is rendered generically from the manifest.

## Web UI — Settings → Plugins (`packages/web/src/app`)

- `services/plugin.service.ts` — Angular signal service over `/api/plugins`: a `plugins` signal,
  `enable(id, consent)` / `disable` / `saveConfig`, and the capability computeds `hasSearch` /
  `hasResolve` / `hasDownload` plus id-specific gates `hasArchive` / `hasSpotify` / `hasSpotdl`
  (the last requires **enabled AND available**, since one-click Spotify download needs the spotdl
  binary present). UI surfaces gate on these. Its `PluginKind` union **mirrors the core one** and
  must stay in sync: a kind missing here has no group computed and no template section, so its
  plugins render **nowhere** — which is exactly how LRCLIB shipped live-but-unmanageable (registered
  _and_ `seedEnabled`, yet absent from Extensions because the union was `acquisition | connectivity`).
- `pages/plugins/plugins.component.ts` — admin-only page (route `/settings/plugins`, `adminGuard`),
  labelled **Extensions** in the UI (linked from Settings → Extensions; identifiers stay `plugin*`).
  Cards grouped by kind — **Acquisition**, **Metadata** (lrclib today), and a generic
  **Connectivity** section — each a collapsible `SettingsGroupComponent` (groupIds
  `plugins-acquisition`/`plugins-metadata`/`plugins-connectivity`, collapsed by default, persisted
  per-device). Connectivity **hides entirely** rather than showing an empty-state — the wiring is
  ready for a tailscale/wireguard plugin to appear with no UI changes, at which point the section
  reappears on its own. Every kind in the core union needs a section here, or its plugins are
  invisible. Enabling a consent-gated plugin opens its disclaimer via `ConfirmDialogComponent` and
  only then calls `enable(id, true)`.
- **`PluginCardComponent` is itself collapsible** (Task 4, settings-cards unification): the header
  row (name, one unified status pill, Enable/Disable) is always visible and toggles independently of
  the card's own expand/collapse button (`data-testid="plugin-card-toggle"`, persisted per-device
  like `SettingsGroupComponent` but via a plain getter/setter, id `plugin-<plugin.id>`, since this
  component keeps the classic `@Input`/`@Output` decorator API — see its class docstring for why).
  Description/capabilities/binaries-warning/the generic `configFields` form only render once
  expanded (`data-testid="plugin-card-body"`).
- **Per-extension bespoke settings, embedded inline**: extensions whose settings are too bespoke for
  the generic config-field form used to link to a dedicated route (`PLUGIN_DETAIL_ROUTES`); Task 4
  removed that route entirely — bespoke UI now renders directly inside the plugin's own collapsible
  card body (`@if (plugin.id === 'slskd') { <app-slskd-settings /> }`), keeping extension-specific UI
  _with the extension_ without a second navigation hop. First (and so far only) consumer: **slskd**
  (`pages/plugins/slskd/slskd-settings.component.ts`). It owns no page chrome of its own (no outer
  container/back-link/`<h1>` — the card's header supplies that); its former `/settings/plugins/slskd`
  route now just redirects to `/settings/plugins`. It renders the Soulseek **connection** form
  (creds/port/UPnP + connect/disconnect), **shared folders**, and a live **status panel** as plain
  sub-headings (no nested collapsibles). It gates its own body on `PluginService.hasSlskd()` (shows
  an enable-first notice when the extension is off), and additionally on **reachability**
  (`slskdReachable` signal): when `GET /api/settings/shares` fails with anything other than 401/403,
  slskd itself is down/absent (e.g. the desktop app's external mode with no slskd running), so the
  connection + shares forms — which could only error — are replaced with a "slskd is not reachable"
  notice (`data-testid="slskd-unreachable-notice"`). The shares section clarifies that **the music
  library folder is shared automatically** (see below); manual entries are for extra folders.
  Because the card body is `@if`-gated on being expanded, this component (and its ~3s status poll
  started in `ngOnInit`) only mounts while the card is open — collapsing it runs `ngOnDestroy` and
  stops the poll. _Backend credential storage is unchanged_ — it still uses the admin-gated
  `/api/settings/soulseek*` + `/api/settings/shares*` routes (`secrets.json`, wired to embedded-mode
  via `slskd-config.ts`); only the UI relocated, to avoid destabilizing the embedded-mode credential
  wiring.
- **slskd status panel (Nicotine+-style)**: `GET /api/plugins/slskd/status` (admin, self-gates on
  the plugin being enabled + a reachable client) returns a typed `SlskdStatus` — current up/down
  speeds, active/queued transfer counts, configured limits (upload/download speed + slots), share
  size, and connection/version/uptime. It aggregates `server.getState()`, `transfers.getDownloads/
Uploads()`, `options.get()` (new JSON options accessor), and `application.getInfo()` via the
  DI-free, unit-tested `services/slskd-status.ts` (`buildSlskdStatus` + `extractSlskdLimits` — the
  limit extractor is defensive because slskd's options JSON shape varies by version). Each probe is
  fetched independently (`Promise.all` + `.catch`) so one failure degrades to zeros, never a 500.
  The panel polls every ~3s while the tab is visible.
- **Generic config-field editor**: a plugin manifest may declare `configFields` (UI descriptors:
  `{ key, label, type: 'text'|'password', placeholder?, help? }`). The card renders a small form
  from them; `GET /api/plugins` echoes `configFields` + a `configured` map (which keys have a stored
  value) + `config` (non-secret prefill values only — **`password` fields are never returned**).
  A blank password input is omitted on save, and `registry.setConfig` **merges** the update over the
  stored config, so "leave the secret blank to keep it" round-trips safely. The build-submit /
  prefill logic is in the DI-free `lib/plugin-config.ts` (unit-tested). The Spotify plugin is the
  first consumer (client id/secret).
- **Unified plugin status pill**: each card shows one derived status —
  Off / Needs config / Unavailable / Ready — computed by the pure
  `lib/plugin-status.ts` `pluginStatus()` from fields `GET /api/plugins` already
  returns (`enabled`, `needsConfig`, `available`); no new API surface. Replaced two
  overlapping badges (Enabled/Disabled + a conditional Unavailable) that could both
  render at once. **Deferred**: today `available` is a config-presence/binary-existence
  check for the stateless API-client plugins (lrclib, discogs, spotify, spotdl), not a
  live reachability probe — adding real probes is future per-plugin backend work that
  would need no UI changes, since the pill already consumes `available` as its source of
  truth. Similarly, slskd's dedicated live status panel (`GET /api/plugins/slskd/status`)
  remains a one-off; generalizing a `health` capability any plugin manifest could declare
  is a separate future design, not attempted here.
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
  Settings → Extensions management UI + capability-gating of the web surfaces.
- **Decoupling refactor** _(done)_ — core **Settings** page slimmed to universal prefs only;
  server-admin tools (streaming, library processing, find-duplicates) moved to **Admin**; slskd
  config + a new live status panel embedded inline in its own collapsible Extensions card (no
  dedicated route). See "Per-extension bespoke settings, embedded inline" above and
  [docs/admin-settings-decoupling.md](admin-settings-decoupling.md).
- **E** _(scaffolded, not shipped)_ — connectivity kind (tailscale/wireguard). The contracts,
  registry, and UI handle the kind generically; a real connectivity plugin can be registered in
  `index.ts` with no further wiring. Per current direction, none is integrated yet.
- **Later** — extract contracts to a standalone `@nicotind/plugin-sdk` and add a dynamic/3rd-party
  loader (the contracts are designed to outlive that change).
- **Auth (OAuth)** _(proposed, not yet implemented)_ — a new `auth` plugin kind with an `oauth`
  capability for Google + Microsoft login. The `OAuthCapability` contract, the two provider
  plugins, DB schema (`oauth_states`), public routes (`/api/auth/oauth`, `/api/auth/callback`,
  `/api/auth/dev-login`), the Capacitor deep-link for mobile, and `.env.example` vars are all
  designed and documented in [docs/oauth-auth.md](oauth-auth.md). No code exists yet.

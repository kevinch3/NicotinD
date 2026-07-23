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

## First-party plugins

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
  **Connectivity** section that currently shows an empty-state (the wiring is ready for a
  tailscale/wireguard plugin to appear with no UI changes). Every kind in the core union needs a
  section here, or its plugins are invisible. Enabling a consent-gated plugin opens its disclaimer
  via `ConfirmDialogComponent` and
  only then calls `enable(id, true)`.
- **Per-extension settings surface (`PLUGIN_DETAIL_ROUTES`)**: extensions whose settings are too
  bespoke for the generic config-field form own a dedicated page. `plugins.component.ts` maps
  `plugin id → detail route` and renders a **Configure →** link on the card when an entry exists;
  otherwise the inline `configFields` form is the whole story (spotify/ytdlp). This keeps
  extension-specific UI _with the extension_ instead of leaking into core Settings. First consumer:
  **slskd** → `/settings/plugins/slskd` (`pages/plugins/slskd/slskd-settings.component.ts`,
  `adminGuard`). That page owns the Soulseek **connection** form (creds/port/UPnP + connect/
  disconnect), **shared folders**, and a live **status panel** — all moved out of the old core
  Settings page. It gates its own body on `PluginService.hasSlskd()` (shows an enable-first notice
  when the extension is off), and additionally on **reachability** (`slskdReachable` signal): when
  `GET /api/settings/shares` fails with anything other than 401/403, slskd itself is down/absent
  (e.g. the desktop app's external mode with no slskd running), so the connection + shares forms —
  which could only error — are replaced with a "slskd is not reachable" notice
  (`data-testid="slskd-unreachable-notice"`). The shares section clarifies that **the music
  library folder is shared automatically** (see below); manual entries are for extra folders.
  _Backend credential storage is unchanged_ — it still uses the
  admin-gated `/api/settings/soulseek*` + `/api/settings/shares*` routes (`secrets.json`, wired to
  embedded-mode via `slskd-config.ts`); only the UI relocated, to avoid destabilizing the
  embedded-mode credential wiring.
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
  config + a new live status panel moved to its own **extension page**. See "Per-extension settings
  surface" above and [docs/admin-settings-decoupling.md](admin-settings-decoupling.md).
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

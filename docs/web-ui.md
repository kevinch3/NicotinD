# Web UI

Angular v22 standalone SPA with signals (`signal()`, `computed()`, `effect()`), `HttpClient` + interceptors, and Angular Router with lazy-loaded routes. Built via `ng build` (esbuild); tests via `ng test` (vitest, integrated via `@angular/build:unit-test`).

## Theme System

CSS custom properties set via `[data-theme]` on `<html>`. Seven built-in presets: **Midnight** (default), **Daylight**, **Warm Paper**, **OLED Black**, **Twilight**, **Forest**, **E-Ink**. Theme is persisted to localStorage (`nicotind-theme`) and applied before first paint (inline script in `index.html`) to avoid flash. **The pre-paint script keeps its own `THEMES` allowlist in sync with `THEME_PRESETS`** — a missing id falls back to `midnight`, so an omitted theme (e-ink was the bug) flashes the default and renders wrong on first paint until hydration.

- Theme service: `packages/web/src/app/services/theme.service.ts` (Angular `signal()` + localStorage)
- Token definitions: `packages/web/src/styles.css` (`@layer base` — `:root` + per-`[data-theme]` overrides)
- **Themed utilities**: semantic classes map tokens to Tailwind (`bg-theme-surface`/`-surface-2`/`-hover`/`-base`, `text-theme-primary`/`-secondary`/`-muted`, `border-theme`). The **accent** utilities (`bg-theme-accent`/`text-theme-accent`/`border-theme-accent`) and a **neutral primary-button** pair (`bg-theme-inverse` = `--theme-text-primary`, `text-theme-inverse` = `--theme-bg`) are defined with Tailwind v4 `@utility` (so `hover:`/`focus:` variants work). **Primary/CTA buttons on themed surfaces must use these, not hardcoded `bg-zinc-100 text-zinc-900`** — the latter is white-on-white on light themes (Daylight/Warm Paper), and `bg-theme-accent` was previously *referenced but never registered*, so accent-filled buttons silently had no fill. **Text/icons painted on a `bg-theme-accent` fill (the nav download-count badges) must use `text-theme-on-accent`** — a per-theme `--theme-on-accent` foreground chosen to contrast each accent (light text on the dark-ish indigo accents, dark text on the light teal/violet/amber ones). The badges previously used `text-theme-base`, which was *never registered as a text utility* (only `bg-theme-base` exists), so the number inherited an arbitrary colour that didn't contrast the accent pill. `bg-theme-inverse` flips per theme (white button on dark themes, dark button on light) so it stays visible while preserving the dark-theme look. **Exception**: the fixed-dark auth screens (login/setup/server-config) and the immersive search surface are intentionally always-dark and keep their `bg-zinc-*` palette. **Now Playing is no longer in this exception** (issue-driven Task 10 of the player-standardization plan, 2026-08): the shell and all 7 extracted sub-components (see "Now Playing — component split + tabbed Queue/Lyrics panel" below) were migrated onto theme tokens (`bg-theme-base`, `text-theme-*`, `bg-theme-accent`, etc.) and now follow the active preset like the rest of the app. The one deliberate holdout is the **fullscreen karaoke overlay** (`NowPlayingKaraokeFullscreenComponent`), whose background is a dynamic gradient computed from the track's cover art (`lib/cover-colors.ts`) — an app theme would fight that gradient, so its text/controls stay literal `text-white/*` against it, same as before. **Coloured accent chips (the blended-results `app-source-chip` per-source tones) must also be theme-aware**: they use `.chip-tone-{soulseek,archive,spotify}` in `styles.css`, which derive both the tint (`color-mix(hue 16%, --theme-surface)`) and the text (`color-mix(hue 60%, --theme-text-primary)`) from the active theme tokens — so the text lightens on dark themes and darkens on light ones. The prior hardcoded `bg-indigo-500/15 text-indigo-300` (and amber/emerald `-300` tints) rendered near-invisible on light themes (Daylight/Warm Paper/E-Ink); the same rule applies to the catalog **artist pills** on Search, which now use `border-theme text-theme-secondary hover:border-theme-accent hover:text-theme-primary` instead of hardcoded `zinc`. The source → class map is the pure, unit-tested `sourceChipToneClass()`. **Semantic status colours** live on the same token system: each theme defines `--theme-status-{progress,done,warn,error}-{bg,text}` (the `warn`/amber role was added alongside the existing three), surfaced as `.status-*` (filled pill = bg+text) and `.text-status-*` (label only) utilities. **Status/warning text on a themed surface must use these, not hardcoded `text-amber-400`/`bg-emerald-500/20 text-emerald-400`/etc.** — those `-400` tints go near-invisible on the light themes; the tokens flip to dark text + light bg there. A codebase-wide audit (2026-07) also **registered a batch of themed utilities that were referenced but never defined** (silent no-ops): `border-theme-surface-2`, `divide-theme-surface-2`/`-border`, `border-theme-secondary`, `ring-theme-bg`/`-accent`, `accent-theme`/`-secondary`; and **migrated the former hardcoded `bg-zinc-*/text-zinc-*` "dark-island" components** (`track-context-menu`, `device-switcher`, `track-info-sheet`, the plugins page, the admin page) onto the theme tokens so they follow the active preset instead of floating as dark panels on light themes. The always-dark exceptions above still keep `bg-zinc-*`; modal scrims (`bg-black/60`), small solid indicator dots, and the destructive `bg-red-600 text-white` confirm button are intentionally left literal. Guarded by `packages/e2e/tests/theme.spec.ts` (probes the computed colours on Daylight/OLED). **The `status-*` family is also registered in `@theme`** (`--color-status-{progress,done,success,error,warn}`, each aliasing that theme's status *text* token): the static `.text-status-*` classes only cover the plain no-variant case, so `bg-status-success` / `bg-status-error/15` / `hover:bg-status-error/10` were referenced at three call sites while Tailwind emitted **no rule at all** for them — the same silent-no-op shape as `bg-theme-accent` above, and the reason the review inbox's `bg-status-success … text-white` Approve button rendered white-on-white on every light theme (issue #591). Registration makes the whole `bg-`/`border-`/opacity-modifier family resolve; a **filled** control should still prefer the `.status-*` pill class, which pairs bg+fg per theme, over `bg-status-*` + a hardcoded `text-white` (white on the dark themes' light-green `--theme-status-done-text` would fail contrast).
- **E-Ink legibility**: e-paper devices flatten thin strokes and low-contrast grays into the page (icons became indistinguishable). The `eink` theme therefore pushes `--theme-text-secondary`/`--theme-text-muted`/`--theme-border` much darker, sets a `font-weight: 500` floor, and a `[data-theme="eink"] svg { stroke-width: 3 }` rule thickens every stroked icon (unitless so it scales per icon; the app draws icons at `stroke-width="2"`). Guarded by `packages/e2e/tests/theme.spec.ts`.
- Settings UI: Settings → Appearance — swatch grid + "Follow system theme" toggle
- **Settings / Admin / Extensions split**: the core **Settings** page holds only universal user prefs, grouped into 4 cards — each with a uniform icon+title+description header (`SettingsGroupHeaderComponent`, `packages/web/src/app/components/settings-group-header/`) — **Appearance** (theme, language), **Playback & Offline** (autoplay, remote cast, offline storage/auto-preserve), **Account & Devices** (identity, sign-out, links, update check), and **Advanced** (developer toggle, and platform-only Server/Desktop/iOS-diagnostics sub-sections, each still gated exactly as before — the card itself is hidden entirely for a non-admin web user with no platform sections to show). Server-admin tools (streaming, library processing, find-duplicates) live on **Admin**; extension config (slskd connection/shares + a live status panel) is embedded inline in the slskd extension's own collapsible card under **Extensions** (`/settings/plugins`, relabeled from "Plugins") — no more dedicated per-plugin route. Admins reach both via links in the Settings → Account section. → [docs/admin-settings-decoupling.md](admin-settings-decoupling.md)
- **Settings-cards unification (all five settings-family views)**: `/settings`, `/admin`,
  `/settings/plugins` (incl. each `PluginCardComponent`), `/settings/devices`, and
  `/settings/agent-tokens` all render their groups through the one shared bordered, collapsible
  `SettingsGroupComponent` (`packages/web/src/app/components/settings-group/`) — **every group
  collapsed by default, with one documented exception** (issue #379): Devices' paired-devices list
  ships `[defaultOpen]="true"` because it is that page's primary content and the common visit
  reason is revoking a device. Devices' pairing panel still mints its code on first expand via
  the `opened` output rather than an eager `defaultOpen`. Open/closed state persists per device to
  `localStorage` under `nicotind-group-<groupId>` (`lib/group-state.ts`), cleared on signout
  (`clearGroupStates` inside `AuthService.resetSession()`) so a shared device never leaks one user's
  expand habits into the next session. Testids: `settings-group-toggle`/`settings-group-body` on the
  card, `data-group-id` on the section, `plugin-card-toggle`/`plugin-card-body` +
  `data-plugin-group-id` on the nested plugin cards (issue #378 — cards no longer reuse
  `data-group-id`, so the consistency/gallery specs' "first `[data-group-id]` card" queries can
  never silently measure a plugin card). e2e specs that need a card's body call the shared
  `expandGroup(page, groupId)` helper (`packages/e2e/helpers.ts`) first, and specs that assert
  collapsed-by-default use its `clearGroupState(page)` sibling; web unit specs share one
  `expandAllGroups` from `packages/web/src/testing/expand-groups.ts` (issue #377 — both used to
  be per-file copies). `tests/settings-consistency.spec.ts` is the CI-run gate that
  every route renders collapsed on load (its `DEFAULT_OPEN` map carries the #379 exception) and that the first card + title resolve to identical
  computed styles across all five routes; `tests/settings-gallery.screens.ts` (out-of-CI, run via
  `cd packages/e2e && bunx playwright test --config=playwright.screenshots.config.ts`) captures a
  collapsed + fully-expanded shot of every route in both a mobile and a desktop viewport for human
  side-by-side review. Full component/persistence rationale (superseded `AdminGroupComponent`, the
  `opened` no-double-fire guarantee, the dead `nicotind-admin-group-` prefix) →
  [docs/design-patterns.md](design-patterns.md) "SettingsGroupComponent".
- **Icon buttons (`app-icon`)**: universal actions (Back, Play/Play All, Download, Share, Add, Delete, Close) render as **icon-only** buttons via `components/icon/icon.component.ts` — a small `name`→glyph set (lucide-style, 24 viewBox, `stroke-width="2"`). Centralizing replaced the hand-copied inline SVGs (Back lived in 3 files) and gives the e-ink stroke rule one shape to thicken. **The button — not the icon — owns the accessible name**: every icon-only button carries `aria-label` + `title` (the `<svg>` is `aria-hidden`), and keeps its `data-testid`. Non-universal/ambiguous actions (Select, Optimize metadata, Remove album, admin CRUD, Reset PW) **stay text**. The `SelectionBarComponent` icon actions are targeted in tests/e2e by `data-testid` (`selection-add`/`selection-delete`/`selection-cancel`).
- **Icons & favicon**: PWA icons (`public/icons/icon-{192,512}.png`, maskable, `apple-touch-icon.png`) **and** the browser-tab favicon (`public/favicon.ico` + `public/icons/icon.svg` + `icon-{16,32}.png`, linked from `index.html`) are all generated from **one brand SVG** in `packages/web/scripts/generate-icons.ts` (`bun run generate-icons`) — the same mark the manifest references, so the tab icon matches the installed-app icon. The `.ico` is built via ImageMagick `convert` (sharp can't encode ICO); it's a dev-only regeneration step (outputs are committed). Served-asset guard: `packages/e2e/tests/favicon.spec.ts`.
- Cover art: `packages/web/src/app/components/cover-art/cover-art.component.ts` — themed placeholder **held until image bytes arrive**. The component wraps a `relative overflow-hidden` container; the gradient+initial sits `absolute inset-0` underneath; the `<img>` is `opacity-0` + `transition-opacity duration-300` until its `(load)` event fires (`imgLoaded.set(true)`), at which point it fades in over the gradient. On error (`imgError`), the gradient stays. An `effect` resets both flags whenever `resolvedSrc()` changes so navigating between items re-shows the placeholder. Pure helpers (`placeholderGradient`/`placeholderInitial`/`placeholderFontSize`) remain exported for unit testing. A `fill` input switches from a fixed px size to `w-full aspect-square`.

## Key Angular Patterns

- **Services with signals**: All Zustand stores became `@Injectable` services using `signal()` / `computed()` (no NgRx). 1:1 mapping: `PlayerService`, `TransferService`, `SearchService`, `ThemeService`, `RemotePlaybackService`, `PreserveService`, `AuthService`, `ListControlsService`.
- **`HttpClient` + `authInterceptor`**: All API calls return `Observable<T>`. The interceptor attaches Bearer tokens and handles 401/403 auto-logout.
- **Domain API services (no monolith)**: the HTTP surface lives in `services/api/` as one stateless `@Injectable` per API domain — `AuthApiService`, `SearchApiService`, `LibraryApiService`, `DownloadsApiService`, `SystemApiService` (status/settings/admin/setup), `PlaylistsApiService` — sharing one web-local types module `services/api/api-types.ts` (`Album`, `Song`, `CatalogSearchResult`, …; *not* `@nicotind/core` schemas). **Inject the specific domain service** you need (`inject(LibraryApiService)`), not a catch-all; a component spanning domains injects each one. The former 988-line `ApiService` god object was split out and removed. Each service has a co-located `*.spec.ts` driving it through `HttpTestingController` (URL + verb + body asserts) — the standard for new endpoints.
- **Cached whole-library reads (`lib/cached-observable.ts`)**: `getArtists()` / `getGenres()` are stable lists the library page re-fetches on every visit; each is wrapped in `createCachedObservable(source, ttlMs)`, which `shareReplay`s one request for repeat `get()`s within the TTL (default 30 s) and drops a *failed* fetch so the next call retries (no error-poisoned cache). `LibraryApiService.invalidateLibraryReads()` clears them; `TransferService.markLibraryDirty()` (the single choke-point behind every `libraryDirty` transition — download/scan/acquire completion + post-delete scan poll) calls it, so a change re-fetches instead of replaying a stale list. Reach for this only on reads needed whole and often; paginated reads (`getAlbums`) stay uncached.
  - **Mutations must `tap(() => invalidateLibraryReads())` (issue #237 audit)**: any `LibraryApiService` write whose server handler mutates `library_artists`/`library_genres` (directly or via a sync rescan) must pipe the invalidation on success, or the Genres tab / Artists grid replays the pre-mutation list until the 30 s TTL lapses (the #210 shape). The full audit of every mutating method + its verdict lives in the same PR body; the ones that invalidate: `setArtistGenre`/`clearArtistGenre` (#210), `fixArtistIdentity`, and (this audit) `applyGenre` (refreshes `library_genres` counts), `applyMetadata` (new-artist insert + orphan prune), `deleteSongs` (runs a resync + can empty an artist/genre), `deleteAlbum` (`pruneOrphanArtist` + empty-genre delete), `resyncLibrary` (full rebuild). Correctly **not** invalidated: artist-image writes (`uploadArtistImage`/`setArtistImageFromAlbum`/`resetArtistImage` — the list's `coverArt` is the stable artist id `/api/cover/:id`, so the list value is unchanged; image freshness is a browser/ngsw image-cache concern, not the list observable), cover/lyrics/licence/bpm writes (not in either list), reclassify/hide (album-grid only, uncached), and `optimize*Metadata` (cover/year/release-type, no artist-set or genre-set change).
- **Standalone components**: No NgModules. Every component declares its own `imports` array.
- **`isXxxEmpty` computed pattern for lazy-loaded tabs**: tabs that fetch data on first visit (artists, genres, compilations, singles in `library.component.ts`) pair each `loadingXxx = signal(false)` with an `xxxFetched = signal(false)` flag (set to `true` in the fetch's `finally` block). The empty-state message is gated behind `isXxxEmpty = computed(() => xxxFetched() && !loadingXxx() && items.length === 0)` so it physically cannot appear before the first fetch completes, preventing the "No items found" flash on tab switch or cold load.
- **`effect()` for side effects**: Replaces React's `useEffect`. Used for audio playback coordination, auto-refresh on download completion, remote device sync.
- **Reactivity & event-handling conventions** (one consistent signal-first standard, no leaked subscriptions/listeners):
  - **State-shaped streams → `toSignal()`**: bridge an Observable that represents *current value* (e.g. the SW version stream in `update.service.ts`) into a read-only signal via `toSignal(...)`, rather than `.subscribe()`-ing into a writable signal.
  - **Subscription teardown → `takeUntilDestroyed(destroyRef)`**: never hand-roll `Subscription[]` arrays or `ngOnDestroy` unsubscribes for lifecycle cleanup. Inject `DestroyRef` and pipe `takeUntilDestroyed(this.destroyRef)` (used in `remote-playback.service.ts`, `settings.component.ts`, `layout.component.ts`). Keep a `Subscription` handle *only* when you need to cancel imperatively (e.g. restart a poll), not for teardown.
  - **RxJS stays where it's the right tool**: genuine multi-subscriber event streams keep using RxJS — the WebSocket message bus (`playback-ws.service.ts` `Subject`) and router events. Don't force-convert these to signals.
  - **Pointer-drag gestures → `createPointerDrag()`**: all `document` pointermove/one-shot pointerup drag gestures go through the shared `packages/web/src/app/lib/pointer-drag.ts` primitive, which owns the left-button guard, the `dragging` signal, and **automatic listener teardown via `DestroyRef`**. Do not hand-wire `document.addEventListener('pointermove'…)` in components. **It also wires a one-shot `pointercancel`** (a touch pan the browser reclaims mid-gesture fires `pointercancel`, never `pointerup`) — the handler defaults to `onCancel ?? onEnd`, so a caller that only supplies `onEnd` still settles its drag state on cancel instead of stranding it `dragging=true` forever; a caller that needs different cancel behaviour (pull-to-refresh: cancel-while-armed still commits) supplies its own `onCancel`.
- **`viewChild()` signal queries**: Replace React `useRef` for DOM element access (e.g. `<audio>` element).
- **Offline downloads (preserve)**: `PreserveService` + IndexedDB layer (`preserve-store.ts`) cache audio + cover blobs locally; the player serves preserved tracks from IndexedDB and falls back to `/api/stream/:id`. Triggered from the UI two ways: a **per-track "Save offline" / "Remove download"** action (built by `offlineTrackAction()` in `lib/track-utils.ts`, wired into the track-row menu on album/playlist/genre detail pages, with the row's green `offline` dot) and **collection-level Download buttons** on those same pages. `preserveCollection(key, name, tracks)` is **keyed by a stable collection id** (album/playlist id, genre slug) into a `batches` map signal — so different collections download **in parallel** and each page shows only its own progress via `batchFor(key)` (a single global batch previously made every collection's button read "Saving…" and blocked starting a second download). Budget is enforced against the live `totalUsage` signal so concurrent batches share one running total and can't collectively overshoot the cap. **Single-track `preserve()` evicts LRU to make room, but the bulk path stops at the cap instead** (`stoppedAtCap`) so a huge collection keeps what fit rather than thrashing the same batch (the genre page fetches the full genre — `getSongsByGenre(slug, 5000)`, API cap raised to 10000 — so "Download" can preserve the whole list up to the cap). The storage **budget is user-configurable** in Settings → Offline storage (1/2/5/10 GB or Unlimited), persisted to `localStorage` (`nicotind-preserve-budget`) and surfaced with a usage bar; the **Library → Songs tab (offline variant)** manages preserved tracks (usage bar + Clear all + list) — see the Library Songs bullet below. (The Downloads page's former "Saved Offline" tab was removed when the offline browse surface moved into Library.)
- **Offline / network detection (reactive)**: `NetworkStatusService` (`services/network-status.service.ts`) exposes a single live `online` signal — from `@capacitor/network` on the native shell (via `getCapacitorPlugin('Network')`, no web-bundle import; Android WebView `navigator.onLine` is unreliable) and from `navigator.onLine` + window `online`/`offline` events on web/Electron. `SetupService.isOffline` is a **`computed`** (`!network.online() || serverUnreachable`), so the four offline consumers — the library source swap + `visibleModes()`, nav gating (`ONLINE_ONLY_ROUTES`), the `app.ts` redirect, and the new banner — all react to connectivity flips **in both directions** with no reload (previously offline was a one-shot boot inference). `SetupService.check()` **skips the boot HTTP probe entirely when already offline**, removing the multi-second blank-screen boot behind the Android offline-launch ANR. **The native seed is async, so `check()` first awaits `NetworkStatusService.whenReady()`** (bounded by `NETWORK_SEED_TIMEOUT_MS` = 1.5 s) — without that await, `online()` was still its optimistic default `true` when the initializer ran, the fast path was silently skipped, and the offline-launch ANR persisted despite it. **The offline switch is now fully automatic in both directions**: the `authInterceptor` reports any status-0 (network-level) failure on an `/api`/`/rest` path via `SetupService.reportServerFailure()`, which fires a **verification probe** before flipping the flag (one flaky request must not bounce the app offline; single-flight; no-op while already unreachable — the recovery poll owns retries); once unreachable, `SERVER_RECOVERY_POLL_MS` (20 s) re-probes until the server answers (zero background traffic when healthy), and a **device reconnect fast path** (a `SetupService` constructor `effect` on the offline→online transition) re-probes immediately so leaving airplane mode recovers in one round-trip — it also fires when `status` is still `null` (an offline *launch* skipped the boot probe, so the app must learn `needsSetup`/server state now), while a healthy already-probed session reconnecting after a blip adds no probe. `verify()` is the **single writer** of `serverUnreachable` in both directions — boot, interceptor report, recovery poll and reconnect all converge there. The boot session refresh (the exported `refreshSession` in `app.config.ts`) now runs **after** `check()` and only when online, so an offline launch keeps the stored session (offline library stays usable) instead of churning on doomed auth calls; on the first return to online a one-shot self-destroying `effect` runs the deferred refresh (roles/flags re-sync without a reload) with `withAutoplay: false` — a playback resume firing minutes after launch when connectivity returns would be a surprise, not a restore. The app-shell **offline banner** (inline in `layout.component.html`, `@if (setup.isOffline())`, now carrying `data-testid="offline-banner"`) renders while offline and auto-hides on reconnect — reactive now that `isOffline()` tracks live connectivity. Mid-use hardening: the player skips a doomed network stream for a non-preserved track when offline and toasts instead of showing an infinite spinner (`player.component.ts` `stopForOffline`); `preserveCollection` swallows per-track offline fetch rejections (no unhandled reject / batch abort); GET requests carry a 30 s `authInterceptor` timeout so a read can't hang in the WebView. Native Sentry drops Session Replay + tracing (the release-only ANR suspect) — see [docs/mobile-app.md](mobile-app.md) §Network / offline detection and [docs/observability.md](observability.md).
- **Disk availability pill (Downloads header)**: `app-disk-pill` (`components/disk-pill/`) shows `used / total` (e.g. "95 GB / 969 GB") with a progress fill that runs **green → red** as the disk fills. Data comes from `GET /api/system/disk` (`SystemApiService.getDiskUsage()`), which `statfs`-es the **music-dir** filesystem (where downloads land) server-side and returns `{ total, free, used }` bytes; the `expandedMusicDir` and an injectable `statfs` are threaded into `systemRoutes(...)`. All formatting/colour maths live in the pure, unit-tested `lib/disk-usage.ts` (`formatBytes`, `usedRatio`, `diskFillColor` — hue-interpolated `hsl()`). The `DownloadsComponent` loads it best-effort on construction and simply hides the pill if the read fails. `data-testid="disk-pill"`.
- **Artist page reacts to `:id` changes**: `ArtistDetailComponent` subscribes to `route.paramMap` (via `takeUntilDestroyed`) instead of reading a one-shot `route.snapshot` in `ngOnInit`, so navigating **artist → artist** while the component is already mounted (e.g. clicking an artist name in the expanded player) reloads the new artist instead of showing the previous one (Angular reuses the instance across the same route config, so `ngOnInit` alone never re-runs). `loadArtist(id)` resets all per-artist state (artist/albums/singles/appears-on/discography/Songs-tab list + observer) before fetching, and guards every async setter against a stale response after a rapid re-navigation. The expanded-player artist links collapse the sheet via a new `ArtistLinksComponent` `(linkFollowed)` output bound only in the now-playing usage. Regression-tested in `artist-detail.component.spec.ts` → "reacts to :id changes".
- **Artist page tabs never collapse; identity fix is immediate**: the artist-detail tab bar (`Albums | Singles & EPs | Appears On | Songs`) renders unconditionally from `visibleTabs()` (only non-empty release tabs + the always-present Songs), and each `@case` carries its own `@empty` slate ("Nothing here yet."). This fixes a bug where an artist with **no own releases but compilation appearances** would, on clicking "Appears On", trip an outer empty-guard (`albums==0 && singles==0 && activeTab!=='songs'`) that swallowed the whole tab bar — leaving a dead "No releases found" screen with no way back. Regression-tested in `artist-detail.component.spec.ts` → "Appears On tab never collapses the tab bar". The **"Fix artist identity"** modal (`ArtistIdentityModalComponent`) gained a 4th radio option, **"Rename this artist"** (free-text prefilled with the current name; posts `{rawName, rename}`), for accent/typo/name corrections that don't merge into another artist — see [docs/library-scanner.md](library-scanner.md). Because the API now runs the rescan synchronously (200, not a fire-and-forget 202), the modal's spinner covers the whole apply and, on success, the artist page routes to the artists grid (`/library?type=artists`) where the split members / corrected name are immediately visible.
- **Auto-preserve queue (PWA lock-screen resilience)**: an opt-in, per-device localStorage toggle in Settings → Offline storage that keeps the next-N queued tracks in IndexedDB so playback survives the browser's locked-screen network throttle (Android Chrome WebView, iOS Web). Off by default — the toggle is "Off / Next 5 / Next 20 / Whole queue" with a one-line explainer. The `AutoPreserveCoordinator` (`services/auto-preserve-coordinator.ts`) wires `PlayerService.currentTrack + queue` into `PreserveService.ensureAutoPreservedFor(target)`, dedupes against `preservedIds + preserving`, and caps concurrency at 3. `PreserveService.autoPreserve(track)` is the same fetch+store path as `preserve()` but tags the row `source: 'auto'` so `evictAutoLRU` (in the store) prefers auto-source LRU over user-saved tracks — radio churn can't evict the user's intentional offline collection. `PreservedTrackMeta.source: 'user' | 'auto'` (DB v3, one-shot cursor migration backfills `'user'` on existing rows). 'Whole queue' is hard-capped at 200 tracks so a runaway radio can't fill tens of GB. Turning the toggle **Off** while auto-saved tracks exist prompts via `ConfirmService.ask(message)` with the count baked in (`"Remove N auto-saved tracks from offline storage?"`) and calls `removeAllAutoPreserved()` only on confirm. Auto-preserved tracks show up in the offline Library Songs tab like any other preserve (mixed in — the `source` field is internal). The coordinator ships in **every environment** (dev / prod / native shells); it's effectively a no-op when `autoPreserveMode === 'off'` (the default), so the dev/native gate that the service worker uses (to avoid stale-cache issues) doesn't apply. Settings live in localStorage so a phone user can enable it without affecting a shared desktop.

## Component Conventions

- **Player expand/collapse gesture**: The mini bar (`player.component`) shows a grab-handle pill (`data-testid="player-grab"`) and opens Now Playing on tap or swipe-up. **The grab hatch itself is wired to the open gesture** (`(pointerdown)="onBarPointerDown"`, `touch-none`) — previously only the bar *below* the pill had the handler, so dragging the visible affordance did nothing. The swipe-up **commits on `onMove` once it crosses `OPEN_THRESHOLD_PX`**, not on `pointerup`: on touch the browser can reclaim a vertical pan and fire `pointercancel` before `pointerup`, so an end-only check dropped real swipes (the "swipe-up unreliable" report). Tap-to-open stays on `onEnd` (`controls` and the `[data-seek]` bar are excluded). The Now Playing sheet (`now-playing.component`) dismisses with a **live-follow** drag: `dragOffsetPx`/`dragging` signals bind `[style.transform]` (downward-only) and toggle `transition-none` so it tracks the finger and snaps closed past a threshold. Pointer wiring for all three (mini-bar open, sheet dismiss, `folder-browser` resize) goes through `createPointerDrag()` (`packages/web/src/app/lib/pointer-drag.ts`). Player text uses `translate="no"` + `.no-callout` to suppress the mobile translate/selection popup. Artist/album navigation lives only in Now Playing — the mini bar never navigates.
- **Pull to refresh (touch)**: one gesture, hosted in the layout shell, not per-page. `lib/pull-to-refresh.ts` `createPullToRefresh()` composes `createPointerDrag()` and is bound once in `layout.component.ts` on `<main>`'s `(pointerdown)`, rendering a spinner indicator absolutely positioned inside it; `PullToRefreshService` is the seam a page uses to say what "refresh" means — `register(handler)` pushes onto a handler stack, auto-unregistered on the registrant's `DestroyRef` (route navigation destroys the page component, so this is route-scoped for free), and `trigger()` runs the top-of-stack handler. This is layout-hosted rather than per-page because the scroll container is `window`/`document` (the app has no per-page scrolling `<div>`), so "pulled past the top" is a single global condition (`window.scrollY <= 0`) regardless of which route is mounted — one gesture host, many registrants.
  - **Gates before a pull can start** (`onPointerDown`, all must hold): `isCoarsePointer()` (a real `matchMedia('(pointer: coarse)')` check — desktop mouse/trackpad never engages it), `window.scrollY <= 0` (only from the very top), `!ScrollLockService.locked` (a fullscreen sheet is up), `PullToRefreshService.hasHandler()` (no page registered = nothing to refresh), and no `[data-no-p2r]`/`input`/`textarea`/`select` ancestor (an explicit per-element opt-out for a nested scroller or a form control that needs its own vertical drag).
  - **Why a non-passive `touchmove` `preventDefault()` is required**: once a pull is intent-classified (`dy` past `PULL_SLOP_PX` and steeper than `dx`), the gesture attaches `document.addEventListener('touchmove', blockTouchMove, { passive: false })`. Without it, the browser reclaims the vertical pan as its own scroll/navigation gesture after ~10px and stops delivering `pointermove` — firing `pointercancel` instead. `overscroll-behavior` does **not** fix this: it only suppresses the *visual/navigation* side-effect (Chrome Android's reload glow, iOS's bounce-triggered nav), it does not keep the event stream alive. This is also why **a `pointercancel` while `phase === 'armed'` still commits the refresh** (`finish()` routes cancel through the same commit path as a clean pointerup) — on touch you cannot rely on ever seeing a real `pointerup` once the pull has crossed threshold, the same lesson `pointer-drag.ts`'s cancel handling and the player swipe-up gesture (`onMove`-committing, not `pointerup`-committing) already encode.
  - **`@media (pointer: coarse) { html { overscroll-behavior-y: contain } }`** (`styles.css`) suppresses Chrome Android's native pull-to-refresh (a full page reload) so the in-app gesture owns it exclusively. `contain`, not `none` — `none` would also kill iOS Safari/WKWebView's rubber-band bounce, which is expected native feel and orthogonal to the reload behaviour being suppressed; `contain` only blocks scroll-chaining/navigation-triggering, not the bounce itself. Scoped to coarse pointers so desktop two/three-finger swipe-back navigation is untouched.
  - **Indicator is spinner-only** (no pull/refreshing copy) — deliberately zero i18n surface. `phase` (`idle`/`pulling`/`armed`/`refreshing`) and `pullPx` (damped via `dampPull`, an exponential-decay curve capped at `PULL_MAX_PX`) drive only opacity/rotation/spin, nothing textual.
  - **Constants** (`lib/pull-to-refresh.ts`): `PULL_SLOP_PX` = 10 (dead zone before intent is classified pull-vs-scroll), `PULL_THRESHOLD_PX` = 70 (arms the refresh), `PULL_MAX_PX` = 120 (damping ceiling — `dampPull` is `PULL_MAX_PX * (1 - e^(-rawPx/PULL_MAX_PX))`, so indicator travel diminishes the further past threshold the finger goes). `PullToRefreshService`: `REFRESH_TIMEOUT_MS` = 15s (a hung handler is abandoned, never wedges the spinner forever) and `MIN_REFRESH_VISIBLE_MS` = 400ms (a handler that resolves instantly still shows a perceivable spin rather than a flash).
  - **Deliberate e2e gap**: CI's Playwright runs Desktop Chrome only, and `page.touchscreen` cannot emulate a real touch pan (no `pointerType: touch` events, no `(pointer: coarse)` media match) — there is no cheap way to drive this gesture end-to-end in CI. Coverage is unit (`pull-to-refresh.spec.ts`, `pointer-drag.spec.ts`, `pull-to-refresh.service.spec.ts`) + layout-integration specs (`layout.component.spec.ts` asserts the indicator renders/positions off `phase`/`pullPx` and that `onPointerDown` is wired) exercising the pure logic and DOM wiring directly, without a real touch input. A manual pass on a real Android/iOS device is the one thing that still needs a human before merge.
- **Safe-area header (iOS notch)**: the sticky top header (`layout.component`) folds `env(safe-area-inset-top)` into its top padding — `pt-[calc(0.75rem+env(safe-area-inset-top))]` (= the old `py-3` top) — and `index.html` declares `viewport-fit=cover` so that inset is non-zero on notched iOS. Without it the header (and content) sat *under* the iPhone status bar/notch on the Capacitor iOS build. It's a no-op on web/desktop (inset resolves to 0 → 12px, asserted in `mobile-ux.spec.ts`); mirrors how the bottom player/nav already use `env(safe-area-inset-bottom)`. iOS on-device positioning is a documented manual gate (see [ios-app.md](ios-app.md)).
- **Full-screen sheets clear the notch too**: the Now Playing sheet (`now-playing.component`) and its fullscreen lyrics overlay are `fixed inset-0` over the same `viewport-fit=cover` page, so their **top-anchored interactive chrome** — the drag-to-dismiss grab pill + close chevron (header), and the fullscreen exit button — would sit *under* the iPhone hardware notch on a PWA / Capacitor build, making the sheet impossible to close (regression: iPhone 13 Pro home-screen PWA, "can't find the player notch to close it"). Both headers pad their top with `pt-[calc(…+env(safe-area-inset-top))]` so the affordances drop below the cutout. No-op on web/desktop (inset → 0). Regression-asserted in `now-playing.component.spec.ts` → "notch / safe-area clearance".
- **Download row overflow contained**: each `download-item` row is `overflow-hidden` (plus `min-w-0` on its wrapping metadata row and `max-w-full` on the expandable storage path), so a long title or file path **stays inside the row's rounded box** (titles `truncate`, the storage path `break-all` wraps) instead of widening the page. On mobile a row that overflowed forced the WebView to zoom out (shrinking all icons/text); `mobile-ux.spec.ts` guards the downloads page against horizontal overflow at phone width.
- **Double-tap-to-zoom disabled app-wide** (`styles.css` → `html { touch-action: manipulation }`): stray double taps on cards/controls were zooming the viewport on touch builds (web + native WebView). `manipulation` is the accessibility-preserving opt-out — it keeps pinch-zoom and scrolling, unlike a viewport `user-scalable=no`. It's an element-selector rule on the root, so the finer-grained gesture surfaces win by specificity: the seek range (`.seek-range { touch-action: none }`) and the player drag handles (Tailwind `touch-pan-y`/`touch-none` utilities). Asserted in `mobile-ux.spec.ts` ("double-tap zoom is disabled via root touch-action").
- **Mini-player layout (two columns on mobile)**: the bar is a 3-section flex row (track info · controls · device switcher). On **mobile** only the track-info column grows (`flex-1`); the controls are content-sized (`flex-none`) and the device-switcher section is content-sized too — so track info fills the bar and pushes the controls to the **right edge** (a clean two-column layout: info | controls). Previously *both* side sections were `flex-1` to keep controls screen-centered, but the right (device-switcher) section is empty unless remote playback is on, so it reserved a wasted half-width "empty third column" and the controls sat marooned in the center (the reported "controls too centered, right part lost" bug). On **desktop** the side sections collapse (`md:flex-none`, track info pinned to `md:w-60`) and the controls reclaim `md:flex-1` to host the inline progress bar. The invariant (track-info is the only mobile `flex-1`; the device-switcher section is never `flex-1`) is asserted in `player.component.spec.ts` → "mini-player layout". `BottomNavComponent` (`components/bottom-nav/`) is a `md:hidden` fixed bar (Home · Library · Downloads · **Search** · Settings; Admin is desktop-only). The Search tab (`/search`, online-only — the route needs the backend) restores the mobile path to the network-browse + URL-acquire page that the radio landing used to link to. The bar is `grid-cols-5`, safe-area-aware: `h-[calc(3.5rem+env(safe-area-inset-bottom))]` + matching bottom padding so the tabs sit above the iOS home indicator. The mini-player floats above it, and the full-screen Now Playing sheet (higher z-index) covers it. **Active tab** uses the theme accent (`--theme-accent`) for both icon+label and a 2 px accent bar painted via a `::before` pseudo-element (`a.is-active` rule in `bottom-nav.component.css`); matches the Downloads badge accent vocabulary and reads cleanly across all 7 themes (E-Ink's black accent keeps it legible). The Downloads tab shows a live badge from the shared `TransferService.activeDownloadCount` computed (also feeding the header `download-indicator`, which additionally sums in-flight `AcquireService` jobs).
- **Bottom chrome layering contract** (`lib/player-chrome.ts`): the mini-player (z-50) anchors one tab-bar height above the viewport bottom on mobile, so its *hidden* state must translate past its own height **plus** the tab bar and be `pointer-events-none` — a plain `translate-y-full` parked the opaque bar exactly on top of the z-40 tab bar whenever no track was loaded, hiding the nav and swallowing its taps until playback started ("lost bottom menu" bug). `miniPlayerSlideClass()` and `mainBottomPadClass()` (consumed by `PlayerComponent.slideClass` / `LayoutComponent.mainPadClass`) centralize this geometry as literal Tailwind class strings (arbitrary values must stay literal for Tailwind's source scan). Related: `PlayerService.playNext()` at end-of-queue now keeps the last track loaded but paused instead of clearing it, so the mini-player (and the persisted session in localStorage, which is wiped when `currentTrack` goes null) survives the queue running out.
- **One-tap smart hunt**: the album-hunt modal (`album-hunt-modal.component`) defaults to the best candidate without a manual pick — `bestCandidate` = top of the server-ranked `filteredCandidates`, `effectiveCandidate` = the user's explicit row selection *or* the best. The footer (with a match%/slots/size confidence chip) downloads `effectiveCandidate` on a single tap; the per-row list remains for power users. The auto-pick row shows a "★ Best match (auto)" hint.
- **PWA share-target → URL acquire**: `manifest.webmanifest` declares a GET `share_target` (`action: "/search"` — Search moved off `/` when the radio landing became the home route, so the share intent points at `/search`; params `title/text/url`). Sharing a link from a phone lands on the search route; `SearchComponent.ngOnInit` pulls the URL via the pure `extractSharedUrl` helper (`lib/share-url.ts`, scans `url`→`text`→`title`) and auto-starts a yt-dlp/spotdl acquisition, then strips the query params so a refresh doesn't resubmit.
- **Watchlist star**: catalog album cards in search show a star overlay wired to the web `WatchlistService` (`isWatched`/`toggle`); a filled amber star means the backend watchlist poller will auto-acquire it.
- **Library Albums controls (consolidated)**: the Albums view is one control row — `[search] [Sort ▾] [Filters ▾(n)]` — replacing the previous four stacked rows (6 list-type chips + a client sort dropdown + 11 track-count chips). **Sort** is the *server* ordering (`albumListType` → `getAlbums(type,…)`, drives the fetch + pagination): Newest / Most Played / Recently Played / A–Z / Random. The old client-side toolbar sort was **removed** because `ListControlsService` defaults `sortField` to the first option and would re-sort each loaded page by name — silently overriding the server order; `gridControls` is now `sortOptions: []` (search-only, preserves order). **Filters** is a `<details>` disclosure (active-count badge) holding **Starred only** (a filter, though the server models it as the `type='starred'` slot — `albumSort`+`starredOnly` resolve to one effective type via `lib/library-filters.ts`), **Min tracks** (a `<select>` replacing the 11 chips, client-side over loaded pages), and **Show hidden** (admin). Resolution logic (`effectiveAlbumListType`/`splitAlbumListType`/`parseMinTracks`/`activeFilterCount`) is DI-free and unit-tested. `data-testid`s: `library-search`/`library-sort`/`library-filters`/`library-filter-{starred,mintracks,hidden,count}`.
- **Library "Songs" tab (`pages/library/library-songs.component.ts`)**: a first-class flat listing of the whole library — the promoted home of what used to be the Downloads "Recently Added" tab. **Online** it reads `GET /api/library/songs` (offset-paginated via a `#songsSentinel` IntersectionObserver), defaults to newest-first (`sort=newest|title|album`), reuses the page's shared `LibraryFilter` (bubbled up through `(filterChange)` so the parent mirrors it to the URL; the local `activeFilter` mirror avoids a one-change-stale fetch since the input propagates a tick later), renders `TrackRowComponent` + the full `SongMenuService.build(song,{removable:true})` menu (queue / play-next / **radio** / go-to-artist+album / add-to-playlist / save-offline / song-info / admin-delete), and offers `createSelection()` + `SelectionBarComponent` multi-select (play / queue / add-to-playlist / save-offline / admin-delete). A leading **server-side text search input** (`data-testid="library-songs-search"`) sends a transient `q` query param alongside sort/filter — the server runs a case-insensitive LIKE against song title, song artist, and album name (`%`/`_`/`\` are escaped so a literal `%` in a query is a literal match, not a wildcard). The input is debounced ~250 ms via `setTimeout` (one refetch per typing burst) and clears pagination on each change. `q` is intentionally **not** part of `LibraryFilter` — it's transient text, not URL-mirrored structured metadata — so it lives only in the component. **Offline** (`[offline]="setup.isOffline()"`) it *replaces* its list + server filters with the on-device `PreserveService.preservedTracks` through a client-side `ListControlsService` search/sort, surfaces the offline storage bar + Clear all, and trims the per-row menu to backend-free actions (queue / play-next / remove-from-device). The parent `LibraryComponent` forces `libraryMode='songs'` and hides the other (server-backed) tabs via `visibleModes()` when `SetupService.isOffline()`, and the Library route is now reachable offline (removed from `ONLINE_ONLY_ROUTES` / bottom-nav `onlineOnly`; the app-level offline redirect now targets `/library`). The `offline` input is now **live**: `SetupService.isOffline()` reacts to real connectivity (see §Offline / network detection), so the component swaps between the server listing and preserved tracks **mid-session** — a `lastOffline`-guarded effect re-loads the right source when the flag flips (the initial load stays in `ngOnInit`), rather than being frozen at boot.
- **Render-windowing for large lists (`lib/render-window.ts`)**: the app is zoneless, so on big views DOM node *volume* — not change detection — is the bottleneck. `createRenderWindow(source, pageSize)` exposes a `visible()` slice + `hasMore()` over a full reactive list; the component mounts only `visible()` and grows it via an `IntersectionObserver` on a `#sentinel` (`data-testid=genre-songs-sentinel` / `library-tab-sentinel`). Applied to the genre-detail songs list (was rendering up to 5000 rows) and the library **Artists / Singles / Compilations** tabs (one shared `#tabSentinel` + `growActiveTab()`, since the tabs are mutually exclusive). The *full* filtered list is kept, so play-all / select-all / search / sort still operate over everything — only the mounted node count is capped. Prefer this over server-pagination when the whole list is needed for bulk actions.
- **Debounced list search (`ListControlsService`)**: the search box binds `searchText()` immediately (responsive input) but the expensive `filtered()` computed (full copy + filter + sort) reads a `debouncedSearchText` that trails by `SEARCH_DEBOUNCE_MS` (200 ms), so a typing burst triggers one filter pass instead of one per keystroke. Matters most on the unbounded Artists list and 5000-song genres.
- **Singles & EPs surfaces (Spotify-style)**: the Albums grid stays album-only; singles/EPs appear in two places. (1) `artist-detail.component` renders a **"Singles & EPs"** card section from `getArtist(...).singlesAndEps`, separate from the album grid. (2) `library.component` has a **Singles** mode (`getSingles(...)`, reusing `ListControlsService` search/sort) alongside Albums/Artists/Genre/Playlists. Cards link to `/library/albums/:id` (the 1–6-track album detail works as-is).
- **Acquire page — acquisition-only (issue #227)**: the page (nav **"Acquire"**, route **`/acquire`**, renamed from `/search`) no longer renders the unified search's `local` results — the former "In your library" album section (`data-testid="library-albums"`, `libraryAlbums` signal) **and** the local "Songs" track finder (`librarySongs`, `TrackRowComponent`, `playLibrarySong`, `toTrack`, `SongMenuService`/`CoverArtComponent` imports) were removed. It now reads unambiguously as "find and add **new** music"; "find what I own" lives fully in the Library tabs/filters + Radio (a search over `library_songs`/`library_albums` still runs server-side — `LibrarySearchProvider`, unchanged, tokenized/diacritic-insensitive — it's just not rendered here). The route rename ships a query-param-preserving `{ path: 'search', redirectTo: 'acquire', pathMatch: 'full' }` redirect so existing `/search?q=…` links/bookmarks/e2e `goto('/search')` still resolve; the `nav.acquire` i18n key labels the desktop nav + mobile `bottom-nav` tab; the component keeps its `SearchComponent` name because the backend is still `/api/search`. When the user can't acquire (a `listener`, or acquisition off deployment-wide per #235), the page shows a **"browse your Library instead" empty state** (`data-testid="search-acquisition-off"`) rather than a blank screen — the reconciliation between #227 and #235. **Left open on #227** (product): whether a lightweight library-find box belongs on the Library page. → [docs/source-agnostic-acquisition.md](docs/source-agnostic-acquisition.md) "Unified search".
- **Network "Songs" lane (acquire one song)**: the raw Soulseek results section defaults to a **song-first view** (a Songs ↔ Folders toggle, `networkView` signal). Pure `lib/song-results.ts` `groupBySong()` collapses the flat per-file network list into one row per song — deduped across peers by normalized `(artist, title)` — and auto-picks the **best copy** (FLAC > other lossless > highest-bitrate lossy, then peer availability: free slot → shorter queue → faster upload → larger size), ordered by query relevance. A single **Download** downloads that best copy via `handleDownload`→`enqueueDownload`; the per-row state (Download/Queued/↓%/✓ Done→Open) reuses `getSingleDownloadLabel`. The Folders view (per-peer directories, "Download folder", full-tree browse) is kept for whole-album grabs. `data-testid`s: `network-view-songs`/`network-view-folders`/`song-results`/`song-result`/`song-download`. This is the UX answer to "find me one song" — the catalog/hunt tools are album/EP-only (see [e2e-playground-findings-2026-06.md](e2e-playground-findings-2026-06.md) §F1).
- **Native playlists**: web `PlaylistService` (`services/playlist.service.ts`, signal-based CRUD over `/api/playlists`) drives a **Playlists** mode in `library.component` (create + list) and the `playlist-detail.component` route (`/library/playlists/:id`: play-all, per-track remove, delete). **Add to playlist** is a shared `TrackAction` (`addToPlaylistAction` in `lib/track-utils.ts`) on `TrackRowComponent` available on **every** track list — album detail, search Songs, **genre detail, and playlist detail** (the genre gap was the reported "can't fill playlists from Pop" bug) — calling `PlaylistService.openPicker([songId])`; a global `AddToPlaylistComponent` modal mounted once in `LayoutComponent` renders when `pendingSongIds` is set, listing playlists + an inline "new playlist" create. Reads JOIN `library_songs` server-side, so a song whose file moved silently drops from the playlist.
  - **In-page song search + proposals** (playlist detail, non-curated only): a reusable `SongPickerComponent` (`components/song-picker/`, playlist-agnostic — just songs + an `excludeIds` filter) debounces free-text input **250ms via `setTimeout`/`clearTimeout`** (matching `LibrarySongsComponent`'s convention, no rxjs debounce operator) against `GET /api/library/songs/autocomplete?q=&limit=` (`LibraryApiService.searchSongsAutocomplete`), filters out songs already in the playlist client-side, and emits `add` on pick. Below it, a **"Suggested for this playlist"** list is fed by `GET /api/playlists/:id/proposals?limit=` (`PlaylistService.getProposals`, thin passthrough — no caching) — cheap token-overlap suggestions (title-tokens when the playlist is empty, track-tokens once it has songs). `PlaylistDetailComponent.refreshProposals()` re-fetches after every mutation site that changes membership (`addSong`, `removeSong`, `removeSelectedFromPlaylist`, and the initial `reload()`) so the list naturally stays current without a dedicated poll; sharing/deleting the playlist don't touch it. `playlistTrackIds()` (pre-existing, derived from `visibleSongs()`) is reused as the picker's `excludeIds`, not duplicated.
  - **Multi-select (bulk add, bulk delete, shift-range)**: the genre/album/playlist detail pages have a **"Select"** mode (a per-page `createSelection()` from `lib/selection.ts` — a DI-free signal factory, never a root singleton, so selection can't leak across routes). `TrackRowComponent` renders a checkbox when `[selectable]` is set; its `selectedChange` emits the originating **`MouseEvent`** so hosts read `$event.shiftKey`. **Shift-click range selection** is centralized in `selection.toggleRange(id, orderedIds, shiftKey)` — it tracks the last-clicked anchor and, on a shift-click, sets the whole contiguous range (between anchor and target, in display order) to match the target's new state; pages pass their displayed list (`genreTrackIds()` / `albumOrderedIds()` / `playlistOrderedIds()`). The anchor resets on `enter()`/`exit()`. The shared `SelectionBarComponent` (`components/selection-bar/`) shows "N selected · Select all · Add to playlist · [Delete] · Cancel"; the Delete button is gated by a `canDelete` input with a configurable `deleteLabel` and a `deleteSelected` output. Bulk-add still routes through `openPicker(ids[])` → `addSongs(id, ids[])`. **Delete semantics differ per page**: genre & album delete from the library (admin-only, `canDelete = auth.role()==='admin'`, confirm dialog → `LibraryApiService.deleteSongs(ids)` with partial-failure messaging, optimistically hidden via `TransferService.addDeletedIds`); the playlist page's button is labeled "Remove from playlist" and removes the selected entries from the playlist only (`PlaylistService.removeSong`, files untouched, no confirm). `exit()` always clears the set. The same shared path drives the Library **Songs** tab (online) multi-select. (The Downloads page no longer has a song selection — it's now the Active-feed view only.)
- **Sharing albums, playlists & artists (read-only links + server-side previews)**: a **Share** button (`data-testid="share-playlist"` on playlist-detail, `share` icon on album-detail, `data-testid="artist-share"` on artist-detail) calls `POST /api/share {resourceType}` to mint a short-lived read-only token; the auth middleware allows GET with `share:true`, and `share-view` renders the album/playlist/artist anonymously. Shareable `resourceType`s are `album`/`playlist`/`artist` (the `share_tokens` CHECK constraint is broadened + legacy DBs rebuilt in `db.ts`, same recreate-to-drop-a-CHECK pattern as `acquire_jobs`). **Curated playlists are shareable too** (a share link is itself read-only; `PlaylistService.get` resolves a `kind='curated'` row for any subject). The response→view mapping is the pure, tested `pages/share/share-view.lib.ts` (`mapSharedAlbum`/`mapSharedPlaylist`/`mapSharedArtist`) — the playlist branch reads `pl.songs` (the API returns `songs`, not `entry`, and has **no `owner`**), subtitles with the track count, and falls back to the first track's cover as the thumbnail; **the artist branch** (issue #229) fetches `GET /artists/:id` + `/artists/:id/songs`, renders the id-keyed portrait (404s to the placeholder — no album-cover fallback, by design) + name + album-count subtitle + bio excerpt + a playable song list (so a guest's 5-min window is a real preview, mirroring albums). **Server-side link previews (OG/Twitter cards)**: link-preview crawlers (Slack/iMessage/WhatsApp/Twitter/Discord) fetch raw HTML and don't run JS, so the SPA's Angular `Meta`-set `og:*` tags were invisible. `routes/share-meta.ts` `shareMetaHandler` (mounted at `GET /share/:token` **before** the SPA catch-all) resolves the token **side-effect free** (never sets `first_accessed_at`), looks up the resource name/cover (`resolveShareMeta` — the artist branch reads `library_artists.name` + a BBCode-stripped/clamped bio excerpt via the pure `bioToShareDescription`, OG `type: 'profile'` since OG has no `music.artist`), and injects real OG + Twitter tags into `index.html` (pure `buildShareMetaTags`/`injectShareMeta`/`publicOrigin` — the last honors `x-forwarded-host/proto` for an absolute `og:image`/`og:url` behind a proxy). The `og:image` carries a freshly-minted 10-min read-only **share JWT** (`mintShareJwt`, from `routes/share.ts`) so the authed `/api/cover/:id` serves the crawler's thumbnail; a real browser falls through to the normal SPA on any miss.
- **Share link opened while logged in → own session, not the guest view (issue #230)**: `ShareViewComponent.ngOnInit` checks `AuthService.isAuthenticated()` **first**. A logged-in user calls the auth-gated, side-effect-free `GET /api/share/:token/resource` (`ShareSessionService.resolve`) to map token → `{resourceType, resourceId}` **without** activating the public 5-minute window (`first_accessed_at` untouched, no public token burned), then redirects to the real in-app page (`inAppShareRoute` → `/library/{albums,artists,playlists}/:id`) under their own full session. Access there is governed by their session, not the share clock, so an expired public window still resolves; an unknown token 404s and falls through to the public path. Only an anonymous visitor hits `activate` (the restricted guest experience). Auth-gating the resolve endpoint means only a real session can resolve-without-activating.
- **Post-login redirect back to the requested URL (issue #231)**: `authGuard` captures the attempted URL when it bounces an unauthenticated user (`createUrlTree(['/login'], { queryParams: { returnUrl: state.url } })`); `LoginComponent` reads it in `ngOnInit`, runs it through the pure `sanitizeReturnUrl` (`lib/return-url.ts` — accepts only a single-slash-rooted in-app path, rejecting scheme/protocol-relative/backslash URLs and a `/login` loop, else `/`), and `navigateByUrl`s there after auth (was a hardcoded `navigate(['/'])`). Deep links (shared artist/album/playlist links, bookmarks) now resume to their target after sign-in instead of dumping the user on home. Native pairing/server-select pre-steps are unaffected (they own their own post-auth navigation).
- **History-aware back navigation**: `NavigationService` (`services/navigation.service.ts`) tracks in-app `NavigationEnd` count and exposes `back(fallback)`, which pops browser history (`Location.back()`) when the pure `shouldUseBrowserBack` (`lib/nav-back.ts`) says we've navigated in-app, else routes to `fallback`. The album/artist detail "Back" buttons use it so album → Back returns to the artist you came from; a fresh deep-link falls back to the artist/library.
- **Seek bar (`app-seek-bar`, native range)**: all three seek bars — the mini-player's desktop bar, the mini-player's **mobile bottom-edge bar** (the only progress UI the mini bar shows on mobile, so it must seek), and Now Playing — share one component, `components/seek-bar/seek-bar.component.ts`, which is a **native `<input type="range">`**. This replaced a bespoke `<div>` + `createPointerDrag` + `getBoundingClientRect` implementation that **kept regressing on Firefox desktop** (click-to-seek and drag did nothing, while touch worked) — the exact failure class of hand-rolled pointer handling. A native range delegates click-anywhere, drag, touch, and **keyboard (arrow keys)** to the browser uniformly across engines, and renders a real **draggable thumb**. The control emits `seek` once on commit (pointer release / keyboard change) so the parent's active-vs-remote dispatch (set `audio.currentTime`, or send a WS `SEEK`) runs once instead of spamming on every drag tick; while scrubbing, the thumb follows a local value so a re-fed `position` can't snap it back. Styling lives in **global** `styles.css` (`.seek-range` + `::-webkit-slider-thumb`/`::-moz-range-thumb`/`::-moz-range-progress`) so the vendor pseudo-elements aren't rewritten by Angular view encapsulation; the fill uses `--theme-accent`. Fill-% math is the DI-free `seekPercent()` in `lib/seek-utils.ts` (unit-tested). The input carries `data-seek` so the mini bar's tap/swipe-to-open handler (`onBarPointerDown` excludes `[data-seek]` targets) never hijacks a scrub; the e2e `player-seek` testid sits on the desktop wrapper to stay unique across the desktop/mobile instances. `createPointerDrag` (`lib/pointer-drag.ts`) is retained for the unrelated mini-bar-open and sheet-dismiss gestures.
- **Now Playing — component split + tabbed Queue/Lyrics panel** (player-standardization plan,
  2026-08, Tasks 2–10): the once-monolithic `now-playing.component` (header, cover art, transport,
  queue, lyrics, and the fullscreen karaoke overlay all inline in one file/template) is now a thin
  shell composing **7 extracted sub-components**, each owning its own template + (where relevant)
  its own local state. Every one of them (plus `PlayerTransportMiniComponent`, the mini-player's
  equivalent extraction) sets `host: { class: 'contents' }` — the shell's root is `fixed inset-0
  flex flex-col`, and an unstyled component host element is a `display: block` box by default that
  breaks the flex column (the `flex-1 min-h-0`/`flex-shrink-0` classes *inside* a child's own
  template become inert, since the shell's flex container only ever sees the host, not those inner
  divs); `display: contents` makes the host transparent so the child's top-level elements
  participate in the parent flex layout exactly as the old inline `<div>`s did (same idiom as
  `DesktopWindowControlsComponent`). Caught late because the symptom (queue panel expanding to full
  content height and overflowing unscrollably instead of filling-and-scrolling) only showed up
  looking at the whole extracted tree together, not any single component in isolation:
  - `NowPlayingHeaderComponent` — drag-to-dismiss handle + device switcher.
  - `NowPlayingCoverArtComponent` — cover art, title/artist, track-info button, context menu trigger.
  - `NowPlayingTransportComponent` — seek bar, transport buttons.
  - `NowPlayingPanelTabsComponent` — the **Queue/Lyrics tab switcher** (below).
  - `NowPlayingQueuePanelComponent` — the "Next up" list: Clear, drag-reorder, per-row remove.
    Owns `clearQueue`/`removeFromQueue`/`jumpToTrack`/the HTML5 DnD handlers itself
    (`PlayerService.clearQueue()`/`moveInQueue(from,to)`/`removeFromQueue(index)` underneath — all
    three still unit-tested in `player.service.spec.ts`); a drag dims the source row to 40% opacity
    and shows an accent top border at the drop target.
  - `NowPlayingLyricsPanelComponent` — the in-place karaoke-styled lyrics view.
  - `NowPlayingKaraokeFullscreenComponent` — the fullscreen gradient overlay.

  The shell still owns cross-cutting state that spans multiple children (lyrics data/loading,
  `activePanel`, `karaokeFullscreen`, the drag-to-dismiss gesture, the queue-resize gesture) and
  wires child outputs back into its own handlers; a child's own spec covers its internal behavior
  (e.g. `now-playing-queue-panel.component.spec.ts` for drag-reorder), while
  `now-playing.component.spec.ts` covers only the shell's own wiring (which child renders for a
  given `activePanel()`/`karaokeFullscreen()`).

  **Tabbed Queue/Lyrics panel replaces the old toggle**: previously, opening lyrics *swapped out* the
  queue in place (`lyricsOpen` boolean, `now-playing-lyrics-toggle` button). `NowPlayingPanelTabsComponent`
  now renders two persistent tabs (`data-testid="now-playing-tab-queue"`/`"now-playing-tab-lyrics"`) —
  the queue tab shows a live count badge, the lyrics tab shows an availability dot
  (`data-testid="now-playing-lyrics-dot"`) when lyrics exist but aren't the active tab. The dot
  (`hasLyrics`, gated on the loaded `lyrics()` matching the current track via `lyricsLoadedForId`
  so a track switch can't show a stale positive from the previous track) only reflects lyrics that
  have actually been **loaded** for the current track — lyrics load lazily on first Lyrics-tab open,
  so the dot stays off from the Queue tab until the Lyrics tab has been visited at least once for
  that track; it does not proactively prefetch/probe availability (a known, out-of-scope limitation,
  not a bug). `activePanel`
  (`'queue' | 'lyrics'`, `NowPlayingComponent.setActivePanel`) drives which panel renders and is
  **persisted per-device** in `localStorage` (`nicotind:np-active-panel`), same durability as the
  queue-resize state below. `lyricsOpen` (the flag the lyrics-load/color-extraction/auto-scroll
  effects gate on) is seeded from the restored `activePanel` at construction (`lyricsOpen`'s field
  declared *after* `activePanel`'s, since class-field initialization order matters) — otherwise a
  page load that restored onto the Lyrics tab rendered an incorrect "no lyrics" empty state until
  the tab was re-clicked. The fullscreen karaoke overlay still fully replaces the tabbed area
  (`@if (!karaokeFullscreen()) { tabs + panel } @else { karaoke overlay }`), independent of which tab
  was active when it opened.

  **JIT vitest harness limitation (read before adding a shell-level test that clicks a child)**: the
  harness doesn't propagate a template `[input]="…"`/`(output)="…"` binding across a *nested*
  component boundary (the input-only half of this is already documented in
  `src/testing/signal-input.ts`; the output half is the same underlying gap — confirmed by a minimal
  repro during Task 10: an `output()`-bound child event routed through a *parent* template binding
  never reaches the parent handler in this harness, while `componentInstance.someOutput.subscribe(...)`
  does). Practical effect: `now-playing.component.spec.ts`'s tab-switch tests drive
  `setActivePanel(...)` directly rather than clicking `[data-testid="now-playing-tab-lyrics"]` (the
  click-emits-the-right-value contract is covered in `now-playing-panel-tabs.component.spec.ts` via
  direct `.subscribe()`), and content that only exists once a nested child receives its inputs (e.g.
  the karaoke fullscreen's current/next line text) is asserted from that child's own spec via
  `setInputValue`, not through the shell. e2e (real Chromium, no JIT harness) has no such gap and is
  the source of truth for the actual click-through behavior — see `packages/e2e/tests/player.spec.ts`
  "Queue tab returns to the queue view after the Lyrics tab (round-trip)" /
  "Queue tab shows the live queue-count badge". **The gap is broader than inputs/outputs — `viewChild()`
  itself never resolves in this harness** (found during a Task 10 fix round: a bare
  `<div #ref>` component's own `viewChild<ElementRef>('ref')` stays `undefined` after
  `detectChanges()`, no nesting involved at all). This means neither `NowPlayingKaraokeFullscreenComponent.overlayRef`/`lyricsScrollRef`
  nor the shell's own `lyricsPanel`/`karaokeFullscreenPanel` viewChildren can be asserted to resolve
  from a spec — only their *real-browser* behavior (e2e) proves that. Where a decision *depends* on a
  viewChild result (e.g. the auto-scroll effect picking which lyrics container to scroll — in-place
  panel vs. karaoke-fullscreen browse list), pull the decision into a pure function taking plain
  values (`lib/lyrics-scroll-container.ts` `resolveLyricsScrollContainer`) and unit-test *that*, the
  same way `scrollToActiveLine`'s pixel math is pure and tested separately from the DOM wiring that
  calls it.
  - **Manual queue resize** (`data-testid="now-playing-queue-resize"`): a drag handle lets the user pull the panel area **taller**, which **shrinks the cover art** to make room (the panel is `flex-1`, so shrinking the cover grows it). The handle is **shell-owned, rendered above the Queue/Lyrics tab bar** — it originally lived inside the queue panel, so after the tab switcher shipped it vanished on the Lyrics tab and users reported the feature as lost; hoisting it makes it work for **both** panels (the queue panel's old `resizing` input / `resizeStart` output API is removed). Driven by the shared `createPointerDrag` (`lib/pointer-drag.ts`); `queueExtraHeightPx` (px the cover has shrunk from its 320px max, clamped to `[0, 200]`) feeds `coverMaxPx = 320 − queueExtraHeightPx`, bound to the cover's `max-width`. The chosen size is **persisted per-device** in `localStorage` (`nicotind:np-queue-extra`) and read on construction, so it survives reload. Unit-tested in `now-playing.component.spec.ts` → "queue resize (drag handle)" + "hoisted resize handle (shell-owned)"; the Lyrics-tab drag is covered end-to-end in `mobile-ux.spec.ts`.
  - **Desktop side panel (`lg:` ≥1024px, Spotify-like)**: the sheet becomes two columns — cover art + transport centered in a flexible left column, the Queue/Lyrics panel (with its tab switcher) an always-visible fixed `w-[380px]` right column (`data-testid="now-playing-body"` wraps both). Because every extracted child uses `host: {class: 'contents'}`, a grid/flex on the root would place each child's *inner* element as an individual item — so the shell adds two **group wrappers that are `contents` below `lg` and real flex columns at `lg`** (`class="contents lg:flex …"`): below the breakpoint the wrappers dissolve and the mobile stacked layout is untouched by construction. The breakpoint is `lg`, not `md` (the app's nav-chrome fork) — a portrait tablet at 768px lacks room for cover + a 380px column, and `lg:` is where the app's grids already assume real horizontal space. The mobile drag-resize handle is `lg:hidden` (a vertical resize is meaningless beside a fixed-width column) and the stored cover shrink is mobile-scoped: `coverMaxPx` rides a **`--np-cover-max` CSS var** (`max-w-[var(--np-cover-max,20rem)] lg:max-w-80`) instead of an inline `style.max-width`, which would beat every class including the `lg:` cap. Karaoke fullscreen is untouched (own `fixed inset-0 z-[70]` overlay at all widths). Covered by `now-playing-desktop.spec.ts` (e2e; jsdom has no layout engine) + the cover-art spec's var-binding case.
- **Mini-player transport** (player-standardization plan, Task 11 — the plan's final task):
  `PlayerTransportMiniComponent` (`components/player/player-transport-mini/`) pulls the
  shuffle/prev/play-pause/next/repeat button cluster out of the mini bar (`player.component`) — a
  pure relocation of markup already covered by `appTvNavGroup`/`appTvNavItem` D-pad nav, not new
  coverage. `playing`/`buffering` stay shell-owned inputs (the shell branches play/pause between
  local and remote-device dispatch); shuffle/repeat inject `PlayerService` directly and call
  `toggleShuffle()`/`cycleRepeat()` inline, same pattern as `NowPlayingTransportComponent` (Task 4).
  Hit the **same JIT harness gap documented above** for Now Playing's decomposition: a parent-level
  spec assertion that set `bufferingVisible` and expected the mini-player's play/pause button to
  render the spinner via the `[buffering]="showBuffering()"` binding failed with `NG0303` (binding
  never reaches the nested component in this harness) even though the value the binding *carries*
  (`PlayerComponent.showBuffering()`) is correct — confirmed with an isolated minimal repro, not
  assumed. Per the same resolution as Task 4/10: the DOM-rendering assertion moved into
  `player-transport-mini.component.spec.ts` (asserted via direct component creation, no cross-boundary
  binding), and `player.component.spec.ts` now asserts only the shell's own `showBuffering()` computed
  resolves correctly — the wiring itself is proven by e2e (`packages/e2e/tests/player.spec.ts`
  "player controls"), which has no such gap.
- **Playback auto-radio**: `PlayerService.radio` (persisted in the player state snapshot) keeps playback going — a constructor `effect()` watching `queue().length` calls `replenishRadio()` when the queue drains to `RADIO_MIN_QUEUE` (and `repeat==='off'`), appending fresh tracks (de-duped against current/queue/recent history). The `RadioProvider` registered by `LayoutComponent` calls `GET /api/radio/next` with the current track as seed — the server scores candidates by BPM, key (Camelot), genre, year, duration, and artist diversity, returning musically similar tracks. Falls back to shuffled recent songs when no seed track. `PlayerService` stays HTTP-free via the `RadioProvider` callback. Toggle lives in the Now Playing sheet. **Filter "vibe" radio**: `PlayerService.radioFilter` (a persisted `LibraryFilter`, set by `startRadioWithFilter(tracks, filter)`) makes the provider replenish via `getFilterRadio(filter,…)` so a mood/genre/bpm radio stays in-vibe; it's cleared when seed radio starts or radio turns off. → [docs/radio.md](../docs/radio.md)
- **Radio landing (`pages/radio-landing/`, the home route `''`)**: the post-login surface, built to *start listening in one tap* — recover a mood or make a new one. Two blocks: (1) **Resume** — a card seeded from the persisted last track (`PlayerService.currentTrack`); tapping `startRadio`s it and the block **disappears** (a local `resumeDismissed` signal; hidden entirely when there's no last track). (2) **New mood** — one-tap **vibe presets** (Happy/Chill/Party/Energetic/Danceable/Uplifting/120bpm+/Acoustic, each a canonical `LibraryFilter` over `MOOD_VOCAB`/perceptual buckets/bpm) + top-genre chips. Each tap calls `getFilterRadio` and hands the result to `startRadioWithFilter` (empty match → a neutral toast, never an error). Mobile-first (thumb-sized chips, inherits bottom-chrome padding from `<main>`), theme-token styled. **Chip hover** is `hover:bg-theme-accent/15 hover:text-theme-accent` (a tinted overlay + accent-colored text, not a solid `bg-theme-accent` fill) so the indigo-on-white pair on **Daylight** + the warm-paper-on-cream pair on **Warm Paper** pass AA without a per-theme accent shadow; pinned by `radio-landing.component.spec.ts → "visual contract"`. The header brand ("NicotinD") logo now points here (`routerLink="/"`) so clicking it lands on the radio landing; `/search` is reachable from the desktop top-nav and the mobile bottom-nav Search tab. `data-testid`s: `radio-landing`/`radio-resume`/`radio-resume-play`/`radio-preset`/`radio-genre`. → [docs/radio.md](../docs/radio.md)

## Page & section idioms (issue #384)

**The problem**: six page-level patterns had drifted independently over time — page wrapper
width/gutters, page titles, section headings, grouped-card chrome, and table framing each had 2-3
slightly different literal implementations across routes (a `max-w-5xl` here, a `max-w-3xl` there,
`space-y-12` on one page and nothing on the next, `rounded-xl border border-theme bg-theme-surface`
copy-pasted per table). No single page was wrong in isolation; the drift only showed up comparing
pages side by side. Issue #384 is the cleanup: four shared utilities + a criteria table for which
tier a new page gets, enforced by a spec so the next page can't silently reintroduce a fifth
variant.

**The four utilities** (`styles.css`, `@utility` block — plain `@layer utilities` classes can't be
targeted by an opacity modifier or `@apply`d from a theme color that isn't `@theme`-registered, so
`text-theme-primary`/`border-theme` inside these declarations are raw `var()`, not `@apply`):

- `page-shell` — `mx-auto px-4 py-5 md:px-6 md:py-8`. The **one** responsive gutter/width scale;
  every routed page inside the app shell adds a `max-w-(6xl|3xl)` alongside it (the width is
  chosen per page, the gutters/padding never vary).
- `page-title` — `text-2xl font-bold` + `--theme-text-primary`. **Every page-level `<h1>`, app-wide
  since issue #385**: settings-family/admin plus the browse/detail tier (album, artist, genre,
  playlist detail, share view, Downloads). Four of the browse pages already carried the exact
  literal classes; Downloads' `text-lg` h1 and genre-detail's `h2` were promoted rather than
  minting a smaller variant — one h1 typography, and the page's identity heading is always an
  `<h1>`. Section headings *within* a page (`text-lg` h2s like radio-landing's, and
  `section-title`) are a different tier and untouched. Guarded by `pages/page-shell.spec.ts`'s
  title drift guard. Auth/onboarding screens (login, setup, pair, server-config) keep their own
  centered branding headers — they render outside the app shell and are not browse pages.
- `section-title` — `text-sm font-semibold uppercase tracking-wider mb-5` +
  `--theme-text-secondary`. The small-caps sub-heading above a section (replaces the raw
  `text-sm font-semibold uppercase tracking-wider text-theme-secondary` literal that used to be
  copy-pasted per page).
- `section-flush` — `rounded-xl border bg-theme-surface/50 overflow-x-auto` + `--theme-border`. The
  idiom for a table: border + horizontal-scroll container, with cell padding doing the interior
  spacing (no `p-*` on the section itself, unlike a card).

### Consolidate columns, don't hide them (the Admin users table)

`hidden sm:table-cell` reads as a tidy way to fit a wide table on a phone, and it is a trap: the
Admin users table hid Online, Devices, Sessions and Joined below `sm:`, which is exactly the data
an admin opens that page to see, and exactly the viewport they are most likely on when they open it
in a hurry. The fix was **fewer columns, not fewer visible columns** — three presence columns folded
into one "Activity" cell with a muted second line, and Joined became the muted second line under the
username. Five columns, all always rendered, no horizontal scroll at 390 px, nothing lost.

Use it as the reference when a table starts to feel too wide: merge related columns into a
two-line cell before reaching for a responsive-hide class. `tests/admin-users.spec.ts` pins both
halves (five `<th>`, every `<td>` visible at 390 px, no page-level horizontal overflow).

The same change is the reference for two component idioms:

- **`MenuPanelComponent` works as a *picker*, not just an action list.** The role control is a
  menu-panel trigger styled as the badge it replaced. Prefer it over a native `<select>` in the app
  shell: a `<select>` swallows arrow keys, which is unrecoverable on a remote (no Tab to escape
  with), and it can't carry the badge's colour variants. Remember the projection slots are strictly
  `[menuTrigger]` / `[menuPanel]` — there is **no catch-all `<ng-content>`**, so a mis-named trigger
  attribute renders nothing at all, silently.
- **Never nest an `appTvNavGroup` inside a `[menuPanel]`**, and never put one on a
  `<table>`/`<tr>`/`<td>`. The panel already owns ArrowUp/Down and stops propagation (issue #389),
  so a nested group double-moves focus per press; and `TvNavGroupDirective` force-sets
  `role="toolbar"` via a host binding, which would clobber a table's implicit ARIA roles. Wrap the
  table in a `<div>` and put the group there.

### `lib/relative-time.ts`

The one "Just now / 5m ago / Yesterday / 4d ago" helper, shared by the Downloads feed and the Admin
users table, and registered in `check:shared-helpers` so a second copy fails CI. The translator is
an **optional parameter** rather than an injected service: that keeps the module pure (testable as a
plain function, no Angular DI) and lets a surface that hasn't been through the i18n pass call it and
get the original English wording verbatim.

**Tier criteria** — pick one when adding a routed page, based on what the page *is*, not how wide it
happens to look today:

| Tier | Pages | Why |
| --- | --- | --- |
| `max-w-6xl` | Library, album/artist/genre detail, Acquire, Downloads | Browse surfaces — grids/lists that want the room. Downloads moved `max-w-5xl` → `6xl` to join this tier rather than keep a one-off width. |
| `max-w-3xl` | Playlist detail, Radio landing, Share view, Admin, Settings, Devices, Agent tokens, Extensions (`plugins.component`) | Reading/mixed surfaces — a mix of prose-width content and wider panels (Admin's tables/forms don't need browse-grid width). The settings-family started one tier narrower (`max-w-2xl`), but the 2xl/3xl split made the content column visibly jump when navigating Settings ↔ Admin ↔ Extensions — all `SettingsGroupComponent` pages now share this tier (issue #420). |

**Section idioms** — once inside a page, three shapes cover everything:

- **Grouped card** = `SettingsGroupComponent` (`components/settings-group/`). This is *the* idiom
  for a collapsible titled block (Settings, Devices, Agent tokens, Extensions, and Admin all use
  it) — never a hand-rolled `rounded-xl border ...` card. It **owns its own `mb-6` bottom margin**
  on the root `<section>` rather than relying on a parent `space-y-6` wrapper. This is a deliberate
  choice, not an oversight: a parent `space-y-*` adds `margin-top` to *every* child including
  `position: fixed` overlay children (the Settings sign-out confirm modal and Admin's hunt modals
  are siblings-in-template of the grouped cards), which offsets a fixed `inset-0` box away from the
  viewport edges it's supposed to pin to. Component-owned rhythm sidesteps that entirely, and it was
  also the smaller diff over re-deriving margins for a parent wrapper on every page that already had
  `SettingsGroupComponent` children.
- **`section-flush`** = any table (Admin's incomplete-jobs/untracked/quota/audit-log tables all use
  it). Cell padding provides interior spacing; the section itself is border + scroll container only.
- **Bare content** = everything else (a plain paragraph, a form, a card-free content block). Not
  every section needs a card — only a collapsible titled block or a table gets one of the two idioms
  above. Admin's legacy card-in-card panels (nested `rounded-xl border ... bg-theme-surface` blocks
  that used to live *inside* a `SettingsGroupComponent` body, plus its `space-y-12` root spacing)
  were stripped down to bare blocks — the outer grouped card already supplies the chrome, so an
  inner card was double framing; its service-status tiles moved from `bg-theme-surface` to the
  softer `bg-theme-surface/50` to read as content-inside-a-group rather than a second nested card.

A static, non-collapsible card idiom (tentatively `section-card`) was **deliberately not added** —
no page currently needs "a card, but never collapsible", so adding the utility ahead of a real
consumer would just be unused surface area. If one shows up, add it as a named `@utility` next to
the other three; never reintroduce a raw `rounded-xl border ...` literal as a one-off.

**Drift guard**: `packages/web/src/app/pages/page-shell.spec.ts` (runs in `bun run test:web`)
asserts, per a `PAGE_TIERS` table, that all 14 routed page templates contain their assigned
`page-shell max-w-<tier>` string, and separately bans the raw bare-surface card literal
(`rounded-xl border border-theme bg-theme-surface` without a `/`-opacity or `-2` suffix) and the raw
uppercase-heading literal on the six idiom pages (Settings, Devices, Agent tokens, Extensions,
`slskd-settings`, Admin). `packages/e2e/tests/settings-consistency.spec.ts` is the runtime
counterpart — it asserts every settings-family + Admin route's first `SettingsGroupComponent` card
and its header resolve to **identical** computed styles (`getComputedStyle`, not just "same class
list"), and that each route's `.page-shell` reports the tier's expected `maxWidth`/padding.

**Rule for a new page**: root element is `page-shell max-w-<tier>`, tier chosen from the criteria
table above. Add the template to `PAGE_TIERS` in `page-shell.spec.ts` — the guard only covers pages
listed in that table, so skipping this step means a new page can drift from the criteria with
nothing catching it; adding the entry is what turns future drift on that page into a failing test.
Pre-auth full-screen shells (login, setup wizard, pair, server-config) are exempt from this rule —
they render before there is an authenticated app shell to be consistent with, so they keep their
own full-viewport layout rather than adopting `page-shell`.

## Boot — player restore never autoplays

`PlayerService.restoreState()` (called from `provideAppInitializer` in `app.config.ts`) loads the last track/queue/history/currentTime from `nicotind_player_state` but **leaves `isPlaying` false, unconditionally**. The snapshot's `wasPlaying` field is still written (harmless, and compatible in both directions with an older bundle) but is ignored on read. The page never attempts a gesture-less `audio.play()` on load, so the user always presses play themselves.

Effect 1 (`PlayerComponent` track-load) honours this: its two `audio.play()` calls are gated on `untracked(() => player.isPlaying())` so a freshly loaded track sits paused (`audio.src` set, `restoredTime` still applied by `onDuration`). Effect 5 (play/pause sync) remains the single authoritative driver of starting/stopping playback in response to `isPlaying`.

**No "tap to resume" banner (removed).** A rejected `audio.play()` (browser autoplay policy, `NotAllowedError`) used to flip a `PlayerService.autoplayBlocked` signal and show a dedicated banner/button over the mini-player and the Now Playing sheet whose only job was to re-issue `audio.play()` from a real click. It was a vestige from before playback restore was paused-by-default (above) — the gesture-less resume path that used to make it common is gone, so it fired rarely, and its Now Playing sheet copy had rotted unnoticed: `unblockAutoplay()` there grabbed the wrong element via `document.querySelector('audio')` (the component always renders two `<audio>` elements and alternates which is active — see the dual-buffer gapless-swap comments on `PlayerComponent.audioEl`), so tapping it silently did nothing. `handlePlayRejection()` now just falls back to paused (`player.pause()`) while the screen is visible — the ordinary Play button is a fresh gesture and succeeds. The screen-locked case (`document.visibilityState === 'hidden'`) is unrelated and unchanged: it still queues a resume for when the app returns to the foreground.

**Removed: the opt-in resume.** There used to be a per-user `autoplay_on_load` preference — a `user_settings` column, a `POST /api/auth/autoplay` route, an `autoplayOnLoad` field on `/me`, `AuthService.setAutoplayOnLoad()`, `PlayerService.maybeResumeAutoplay()` and a Settings → Playback toggle — whose only effect when enabled was to make the app start playing audio on page load. Off was already the default and the better behaviour, so the whole path is gone; the column is left in place (nothing in this schema drops columns, and `config-export.ts` / `privacy.ts` read `user_settings` generically). Restoring the queue, track, shuffle/repeat/radio, context and seek position is unaffected — only the gesture-less `play()` disappeared. Guarded by `player.service.spec.ts` ("restore never resumes playback"), `settings.component.spec.ts` ("renders no autoplay-on-load toggle"), `player.component.spec.ts` ("loading while paused doesn't call play"), and `e2e/tests/player.spec.ts` ("reload leaves the player paused by default").

## The `/get` workspace — Acquire + Downloads merged

Acquire and Downloads were two top-level nav items for two halves of one job: *ask for music* → *watch it arrive*. They are now one route, `/get`, with an internal `?tab=find|downloads`. This is the same defect issue #227 fixed, in reverse — there, one page was trying to be two things; here, one job was split across two pages. The test either way: **can a user state the page's one job in a sentence?**

### The shell, and why `@if` is load-bearing

`GetComponent` (`pages/get/`) is deliberately thin — ~60 lines owning the tab bar, the `?tab=` param, and the active-download badge. Its template is two branches mounting the **untouched** `SearchComponent` and `DownloadsComponent`. Neither child's TypeScript changed, so every `data-testid`, service injection and lifecycle hook survives.

The `@if` must never become `[hidden]`. `PullToRefreshService` is a **stack spliced on the registrant's destroy** (`services/pull-to-refresh.service.ts`), and both children register a handler — Search re-runs the query, Downloads calls `kickPoll()`. Destroying the inactive child is what unregisters its handler, so the pull gesture always refreshes the tab you're actually looking at. The same destroy also stops `SearchComponent`'s result poll and runs its `cleanupSearch(id)`. With `[hidden]` both leak, and the wrong handler wins (the stack returns the *last* registered).

Downloads polling is unaffected by any of this: `TransferService.startPolling()/stopPolling()` are owned by `LayoutComponent`, app-shell-wide, not by the page.

### Tab state is in the URL, unlike Library's

Library keeps its tab in `localStorage`; `/get` keeps its tab in the URL. The difference is intentional — "show me my downloads" has to be linkable, and `/downloads` redirects onto it. `?tab=` is user-editable, so `parseGetTab` treats anything unrecognized (including `'DOWNLOADS'`) as the `find` default rather than rendering a blank pane.

### Redirects need a *function* `redirectTo`

`/search`, `/acquire` and `/downloads` all still resolve. A string `redirectTo` can only **preserve** incoming query params, never **add** one — but `/downloads` has to arrive with `tab=downloads`. Angular's `RedirectFunction` (`(PartialMatchRouteSnapshot) => string | UrlTree`) runs in an injection context, so `redirectToGetTab` in `app.routes.ts` injects the `Router` and builds the UrlTree itself, merging `queryParams` with the tab. That's what keeps a bookmarked `/search?q=…` landing on its query.

### Gating, and the nav going to four

`acquireGuard` now covers the whole merged route. Previously `/downloads` was hard-guarded while `/acquire` only soft-gated itself with an in-template empty state — an asymmetry a merged route can't keep. A listener (or an `NICOTIND_ACQUISITION=off` deployment) simply never sees the nav item, which retires `search-acquisition-off` as a reachable state; the block stays in the template, since it's still correct if the component is ever mounted for a non-acquirer.

Nav is now **Home · Library · Add · Settings** (the route is `/get`; the label is `nav.get` → "Add"). Two fixes rode along:

- The mobile bar's column count is **derived** (`gridColumns()` → `repeat(N, minmax(0,1fr))`) instead of a hardcoded `grid-cols-5`. The old value was already wrong for listeners, who saw 4 tabs in a 5-column grid with a dead trailing column.
- The mobile badge now counts in-flight URL acquisitions, matching the desktop formula. They had silently disagreed: a spotdl/yt-dlp job showed a count on desktop and nothing on a phone.

`/get` is deliberately **not** in `ONLINE_ONLY_ROUTES` even though its Find tab needs the network — the Downloads tab never was, and gating the whole item would hide the download feed offline. The app-shell offline banner carries that message.

## Library find bar — cross-type, not per-tab

One box above the Library tabs searching everything you own at once: **Albums, Artists, Songs**, grouped by type, in `LibraryFindComponent` (its own file — `library.component.ts` is already 759 lines across 7 tabs).

A non-empty query **replaces** the tab content rather than filtering the active tab. That's the whole point. `feedback-log-2026-07` item #7 was a user whose album row was clean and whose tracks were all present, but who concluded the release was missing because no album *card* ever surfaced — they were looking at the wrong result type. A filter scoped to the active tab reproduces that failure by construction; a cross-type result set is what closes it. The e2e case asserts exactly that: an artist+title query surfaces an **album card**.

Mechanically:

- `browseMode()` is `computed(() => find() ? null : libraryMode())`. The seven tab-content blocks switched from `libraryMode() === …` to `browseMode() === …`; the tab *bar* still reads `libraryMode()`, so the user's tab stays visibly selected underneath and clearing the box returns them to it. This avoided re-indenting ~480 lines of template to wrap it all in one conditional.
- Typing is debounced 250 ms into `find`, mirrored to `?find=` with `replaceUrl` so a search is linkable and survives reload without spamming history. `libraryMode` is never written by the find bar.
- No matching of its own. `/api/search`'s local lane (`LibrarySearchProvider`) already tokenizes, NFD-folds diacritics, ANDs per token over a `name+artist` haystack, and excludes quarantined (`landed_at IS NULL`) rows — it is precisely the matcher the #7 fix installed.
- A monotonic `generation` counter discards a slow response for a query the user has already typed past, and stops it clearing a spinner the newer request owns.
- A failed request renders `library-find-error`, **not** the empty state. Collapsing the two would tell a user they don't own music they do own.

Deliberately out of scope: **playlists** (the local lane returns `{artists, albums, songs}` only — adding them is an API change), and any **acquisition handoff** from the results. Library is a listening surface; the bridge to `/get` is the nav item. The Songs-tab search box stays as a within-tab filter.

Offline the bar is hidden (`findAvailable()`), since the local lane is unreachable and the page falls back to on-device preserved tracks.

## Queue semantics — what a click replaces (issue #233)

A track click used to call the bare `PlayerService.play(track)`, which sets `currentTrack` + `isPlaying` and **never touches `queue`**. So clicking one track left whatever was queued before in place, and `playNext()` pulled that unrelated queue as soon as the deliberately-clicked track ended. The fix is not "always clear the queue" — that would wipe the queue on every album-track click too. It's making the *gesture* decide, via three explicit entry points:

| Method | Queue effect | Used by |
| --- | --- | --- |
| `play(track)` | untouched — **primitive** | only queue-owning callers (`playWithContext`, `playNext`, `jumpToQueueIndex`) and `RemotePlaybackService` state sync, which must not mutate local queue state |
| `playSingle(track)` | replaced (queue + history emptied, `context` nulled) | a context-less click, and `startRadio(track)` |
| `playWithContext(tracks, i, ctx)` | replaced by *that list* from `i` | every row click inside a list |
| `jumpToQueueIndex(i)` | consumes `[0..i]`; skipped entries + the outgoing track go to `history` | the Now Playing "Next up" row tap |

A row click in a list is always `playWithContext` — the list becomes the queue. Two surfaces were still on the bare primitive and are fixed: **album detail** (`playSong` now resolves the clicked song's index within `albumTracks()` and plays from there with an `album` context; falls back to `playSingle` if the song isn't in the album's track list) and **genre detail** (`playSong` plays from the clicked index through `filteredGenreSongs()`). `now-playing.jumpToTrack` moved from `play()` — which left the tapped entry *in* the queue, so it replayed the moment it ended — to `jumpToQueueIndex`.

`startRadio(track)` clears the queue too: radio replenishes from the current track, so a leftover queue played out in full before the radio the user asked for ever started. `toggleRadio`'s eager fill covers the now-empty queue. `startRadioWithFilter` already set its own queue and is unchanged.

Guarded by `player.service.spec.ts` (`playSingle` / `playWithContext` / `jumpToQueueIndex` / `startRadio` describe blocks).

## Playback loading feedback (HDD-aware loaders)

> This section is about **spinners** — feedback for an action already in flight.
> For the placeholders that stand in for *not-yet-arrived list content*, see
> "List loading skeletons" below; that section carries the rule for which
> feedback a given surface should use.

Libraries often sit on HDDs: starting an uncached track or seeking into an
untranscoded region can take multiple seconds. All loading feedback derives
from one source of truth on `PlayerService`:

- `buffering` — raw state. Set synchronously the moment a new track load
  begins (Effect 1 / `onEnded` src assignment in `PlayerComponent`) and from
  native audio events: `waiting`/`seeking` set it, `stalled` sets it only when
  `readyState < HAVE_FUTURE_DATA` (plain `stalled` also fires on harmless
  network hiccups), `playing`/`canplay`/`error` clear it, and `seeked` clears
  it when `readyState >= HAVE_FUTURE_DATA` (a paused seek into an
  already-buffered region fires neither `playing` nor `canplay`, so without
  this the spinner would stick until the next play). Active-device only —
  remote-controller tabs always read `false`.
- `bufferingVisible` — the render-safe view: turns on only after 250 ms
  (cached tracks must never flash a spinner), turns off instantly. Surfaces
  bind to this, never to raw `buffering`.
  **Constraint:** `setBuffering(true)`'s de-dup guard reads `bufferingVisible`
  through `untracked()`. It is called from inside reactive contexts
  (PlayerComponent's track-load effect), and a plain signal read there would
  silently register `bufferingVisible` as a dependency of the *calling* effect
  — see Firefox bug #3 below. Keep any future signal reads inside
  `PlayerService` setters untracked for the same reason.
- `bufferedRanges` — snapshot of `audio.buffered` (from `progress` events),
  cleared on every new load and when the device goes remote.

Surfaces:

- **Play/pause buttons** (mini-player + Now Playing, incl. the lyrics-panel
  controls): spinner replaces the icon while `bufferingVisible`; the button
  stays clickable (pause = cancel).
- **Track rows** (`TrackRowComponent`, injected `PlayerService`): the current
  row accents its title and swaps the index number for a spinner (buffering),
  animated `.eq-bars` (playing), or static bars (paused) — logic in the pure
  `rowPlaybackState` helper (`lib/row-playback-state.ts`). Because
  `currentTrack` is set synchronously on click, the row acknowledges a tap
  before any bytes arrive. E2e contract: `data-testid="track-row"`,
  `data-testid="track-row-title"`,
  `data-playback-state="buffering|playing|paused"`.
- **Seek bar**: `buffered` input renders `bufferedRanges` as a lighter band
  (`--seek-buffered-bg` gradient built by the pure `computeBufferedSegments` +
  `bufferedGradient` helpers in `lib/buffered-ranges.ts`) under the accent
  fill, so users can see what's safe to seek into. Firefox keeps its native
  `::-moz-range-progress` fill; the band rides the track background in both
  engines.

Deliberately out of scope: buffering over the remote-playback WS protocol
(controller tabs show remote state, not remote buffering).

**Firefox "never plays" bug #2 — the Angular service worker was intercepting
stream requests.** `Driver.handleFetch()` in the generated `ngsw-worker.js`
unconditionally calls `event.respondWith()` for every same-origin fetch — there
is no `dataGroup` configured to opt `/api/stream` out (`ngsw-config.json` only
declares `assetGroups` for the app shell/CSS/JS/icons). For most requests that
resolves to a harmless passthrough, but in Firefox specifically it sometimes
throws instead of falling through to the network for a Range request,
surfacing in DevTools as "A ServiceWorker intercepted the request and
encountered an unexpected error" — the track never plays, and which tracks hit
it is intermittent (SW-state-dependent), not tied to the file itself. Fixed by
routing every stream URL through `ServerConfigService.streamUrl(id, token)`,
which appends `ngsw-bypass=1` — Angular's own documented escape hatch;
`onFetch()` returns immediately, before any Driver logic runs, when it sees
that param. All `/api/stream` call sites (`PlayerComponent`, `PreserveService`,
share view) go through this one method now — never hand-build a stream URL.

**The rule covers every streaming `/api` endpoint, not just audio (issue
#545).** The Admin panel's two `EventSource` connections
(`/api/admin/processing/stream`, `/api/system/logs/:service/stream`) were
hand-built without the param and hit the identical Firefox failure — the SW
intercepts an SSE connection exactly as unconditionally as a Range request.
They now go through `ServerConfigService.sseUrl(path, token)`, the SSE sibling
of `streamUrl()`: one helper so a future SSE endpoint can't re-omit it. Never
hand-build an SSE URL either.

**Firefox "never plays" bug #3 — the track-load effect aborted its own load in
a ~300 ms loop.** `setBuffering(true)`'s guard (`if (timer !== null ||
this.bufferingVisible()) return`) *read* `bufferingVisible` while running
inside PlayerComponent's track-load effect, making `bufferingVisible` a hidden
dependency of that effect. Whenever a stream's first byte took longer than the
250 ms spinner delay (fresh server-side transcode ≈ 4 s of ffmpeg, remote
proxy latency, HDD spin-up), the timer flipped `bufferingVisible` → the effect
re-ran → `audio.src` was re-assigned, aborting the in-flight request
(`NS_ERROR_PARSED_DATA_CACHED` in the network log) → audio events flipped
`buffering` back → re-run again, forever. Firefox never left `readyState 0`
(pause icon / spinner alternation); fast paths (localhost, already-cached
transcodes reaching `canplay` in <250 ms) never armed the timer, which is why
it looked track-specific and "mostly transcoded files". Chrome recovers from
the same re-assignment pattern, so it read as Firefox-only. Fixed by wrapping
the guard read in `untracked()`; regression-pinned in `player.service.spec.ts`
("setBuffering(true) inside an effect does not subscribe the effect to
bufferingVisible"). Diagnosed by instrumenting `HTMLMediaElement` src/play in
a Playwright Firefox run against prod — the loop's ~300 ms cadence and the
single looping call site (the load effect) identified the dependency; verified
by rebuilding master vs. fix behind a 900 ms first-byte delay proxy (master:
20 src assignments, never plays; fix: 1 assignment, plays).

**"Plays 1-2 s then advances" bug — false `ended` recovery.** The user reported
a track playing for 1-2 s, the seek bar reaching 100 %, and the queue
advancing. Returning to the track played it correctly. The browser fires
`ended` on the audio element, the player's `onEnded` handler advances the
queue, and the user never sees the full track. Two root-cause families
contribute and both are defended in depth:

- **Server cache integrity** (see [library-scanner.md](library-scanner.md)
  "Transcode cache integrity"): a transcode cache file at the final name that
  is too short — from a corrupt write predating the temp-rename protection,
  from a successful-but-truncated ffmpeg pass, or from a pre-`600f763` cache
  predating the disk-cache fix — is treated as garbage and re-transcoded
  (size floor + ffprobe post-check + source-size in key + in-use pin).
- **Frontend false-ended guard** (`PlayerComponent`):
  - `onDuration` rejects a browser-reported `audio.duration` that fails
    **both** the 70 %-of-API relative check AND the ±5 s absolute check
    (helper: `browserDurationIsAcceptable`). The seek bar keeps the
    API-known `track.duration` (from the source tag metadata) until the
    browser proves the real value via a `canplay`-time `durationchange`.
  - `onEnded` runs `isFalseEnded(audio)` first: if `currentTime` is < 70 % of
    the known duration, or the browser's reported duration is far off the
    API one, the queue does NOT advance. The track is paused, `recoveryState`
    is set to `awaiting-duration`, and the player waits for a real
    `durationchange` (or `canplay` with a sane duration) before resuming
    playback from the audio element's current position.
  - A 5 s `recoveryTimeout` is the safety valve: if no sane duration
    arrives, the recovery gives up waiting and seeks to 0 + plays, so a
    truly-corrupt file doesn't strand the user on a frozen track.
  - The seek bar's `safeProgress` no longer falls back to `t` when the
    duration is unknown — it stays at 0 — so the user does not see a
    100 %-filled bar during recovery (the "seek bar at 100 %" part of the
    symptom).
  - A `loadGeneration` counter (bumped on element swap, captured at listener
    bind time) is a defense-in-depth filter against stale events that could
    otherwise leak into queue handling during a cross-element handoff.

Regression coverage: `player.component.spec.ts` has a dedicated
`premature ended (false positive) recovery` block — browser durations that
fail the gate are rejected, the queue does not advance on a false `ended`,
the 5 s recovery timeout falls back cleanly, and a `canplay`-time sane
duration exits recovery and resumes playback. The pure `browserDurationIsAcceptable`
helper has its own block covering the AND/OR semantics. e2e: a
`force-transcoded track plays its full duration` case in
`tests/playback.spec.ts` enables force transcode, plays a 30 s fixture
FLAC, and asserts after 5 s of playback that the browser-reported duration
is still ≥ 25 s and `currentTime > 5`.

**Uncovered path (issue #234): missing API-known duration disabled every guard above.** Both
`browserDurationIsAcceptable` and `isFalseEnded` key off `track.duration` from
the API; when it's `0`/missing (the library scanner writes `duration: 0` for
a file whose tags carry no parseable duration — `library-scanner.ts`, or an
untagged URL acquisition), the old code treated that as "no reference, trust
the browser" and skipped both checks entirely. A track in that state hitting
a genuinely truncated/corrupt transcode played 1-2 s, fired `ended`, and
advanced the queue exactly like the original bug — none of the mitigations
above ever engaged, because they all short-circuit on `known <= 0`. Fixed by
giving both functions an **absolute-floor fallback** (`FALSE_ENDED_ABSOLUTE_FLOOR_SEC`,
3 s) when there's no known duration to compare against: a sub-floor native
duration is rejected/flagged regardless, since a real track essentially never
ends that short. Regression coverage: `browserDurationIsAcceptable` gained
floor-boundary cases for a missing known duration, and a new
`false-ended recovery without an API-known duration (issue #234)` block
exercises the full `onEnded`/recovery flow against a track with no
`duration` field — asserting the queue does not advance, recovery still
resolves once a real duration arrives, and a legitimately tiny (≥ 3 s) track
with no known duration still plays through normally (no false positive).

**The recovery itself never terminated (bounded by `MAX_RECOVERY_ATTEMPTS`).** Both fixes above
make `onEnded` *refuse* to advance on a false `ended` — but nothing capped how many times it could
refuse. `onEnded` re-entered `startRecovery` on every false `ended`, and the 5 s valve resets
`recoveryState` to `'normal'` and then seeks to 0 + plays. So a resource that is *genuinely* short
(a truly truncated cache file, not a mis-parse) ends early again, is flagged false-ended again, and
restarts every ~5 s — **forever, never reaching the next queue item**. The `startRecovery`
early-return on `'awaiting-duration'` doesn't help: the valve has already cleared that state. The
guard that was meant to stop a premature advance had become a guard against *ever* advancing.

Fixed with a per-load attempt bound: `MAX_RECOVERY_ATTEMPTS` (3), counted in `recoveryAttempts`,
incremented inside `startRecovery`. Once the allowance is spent, `onEnded` falls through to the
normal advance path and the resource is treated as legitimately short — a corrupt file costs ~15 s
rather than stalling the session. The counter resets when a **new resource** takes over, not when a
recovery succeeds, so the same element can't refresh its own allowance indefinitely.

Found alongside it: both recovery-exit sites assigned `this.recoveryTimeout = null` **without**
`clearTimeout`, which only forgets the handle — the armed 5 s valve still fired after a *successful*
recovery and ran `audio.currentTime = 0`, yanking the listener back to the start of the track. The
two sites now share one `clearRecoveryTimeout()` helper (also used by `startRecovery` and
`ngOnDestroy`), so the handle has a single teardown path. The two bugs compound: the stray seek-to-0
can itself provoke another early `ended`, feeding the loop the bound is there to stop.

### Web test harness — plain vitest, NOT `ng test`

The suite runs on **plain vitest** via `packages/web/vitest.config.ts`, whose `angularTemplateInliner`
plugin inlines `templateUrl`/`styleUrls` at transform time so JIT compilation works without the
Angular CLI. `packages/web`'s own `test` script is `vitest run`, and CI has always run it
(`ci.yml` → `bun run --filter @nicotind/web test`).

`ng test` (the Angular CLI's own unit-test system) is **not** a drop-in alternative and must not be
wired up as one: it **forbids `vi.mock` on relative imports**, which five specs rely on
(`layout`, `settings`, `setup`, `desktop-title-bar-overlay`, `desktop-window-controls`), and it
collects a different subset. The root `test:web` script used to point at it and failed on `master`;
it now aliases the real harness.

**Specs are type-checked separately, and this is load-bearing.** `tsconfig.app.json` excludes
`**/*.spec.ts` and vitest transpiles without type-checking, so for a long time a spec stub could
diverge from the interface it asserts against and every test still passed. That is exactly what
happened: 30 accumulated type errors across 14 spec files (stale `AcquireJob`, `Song`,
`ServiceReview`, `PreservedTrackMeta` stubs; `ProcessingSettings` imported from the wrong module;
`taskPending` records missing task ids added later).

`tsconfig.spec.json` does include the specs but couldn't run standalone — it inherited an `outDir`
while `@nicotind/core` resolves to `src/types/core.ts`, which re-exports from `../../../core/src`,
putting sources outside the inferred `rootDir` (48 × TS6059). Fixed with `noEmit` + an explicit
`rootDir: "../.."`, exposed as `typecheck:web-spec` and run in CI **before** the tests. Without that
step the fixed stubs would silently rot again.

**Templates are type-checked too, by `ngc` (issue #273).** Neither `tsc --build` nor
`typecheck:web-spec` sees an Angular **template**: binding expressions are compiled by the Angular
compiler, not by `tsc`, so an ordinary type error inside `[src]="…"` was invisible to both fast
gates and only surfaced at `ng build` — the *last* step of the CI `ci` job, after lint and every
test. Two real examples, both from the #263 cover consolidation and both reproduced to verify this
fix: `TS2322: Type 'string | null' is not assignable to type 'string | undefined'` on
`metadata-fix-modal.component.html`, and `TS2339: Property 'artist' does not exist on type
'BlendedCandidate'` on `album-hunt-modal.component.html`. `tsc --build` exits **0** on both.

`typecheck:template` runs `ngc -p tsconfig.template.json`, the same template type-checker the build
uses, without bundling or emit — and it is **folded into `bun run typecheck`** rather than left as a
separate command a caller must remember. That choice is measured, not assumed: a green production
`ng build` is **9.0 s** and `ngc` alone is **5.4 s**, so a "faster standalone check" would have won
almost nothing; what makes the fold worth it is that `tsc --build` is incremental, so the combined
gate costs **~5 s warm** (~11 s cold) and closes the "green locally, red at build" class outright.
CI needs no workflow change — it already calls `bun run typecheck`, which now fails on step one
instead of the last one.

`tsconfig.template.json` exists rather than reusing `tsconfig.app.json` because of the **same
TS6059 trap** described above: `app`'s `outDir` makes TypeScript infer a `rootDir` of
`packages/web`, which the `src/types/core.ts` shim's `../../../core/src/*` re-exports sit outside
of. The spec config solves it with `noEmit` + an explicit `rootDir: "../.."`; the template config
drops `outDir` and asserts `noEmit`, which removes the inference entirely.

**Testing `input()`-signal components (JIT vitest limitation)**: the web unit
suite runs on the JIT/vitest harness (`@angular/compiler`, no ngtsc build step),
which registers no signal `input()`s on the component definition — neither a
template `[foo]="value"` binding nor `componentRef.setInput()` reaches them.
Use the shared **`src/testing/signal-input.ts` `setInputValue`** helper, which
writes straight to the input's underlying signal node via Angular's `ɵSIGNAL`
symbol. It was duplicated verbatim across **14 spec files** (in two spellings)
until issue #254 gave it one home; the constraint had been re-explained in each
copy, in each author's own words, which is why the rules below kept getting
rediscovered the expensive way.

**`componentRef.setInput()` was measured, not assumed to be unavailable.** It is
a silent **no-op** in this harness — with *and* without a following
`detectChanges()`, the input keeps its default and every downstream `computed()`
reads the default. It does not throw, which is what makes it dangerous: a spec
written that way passes *vacuously*. Re-run that check before re-litigating; if
a future `@analogjs/vite-plugin-angular` registers inputs properly, the helper
can be deleted outright in favour of the supported API.

Three rules, all documented on the helper itself:

- **Never `input.required<T>()` on a component intended to be nested.** The
  harness doesn't register signal inputs on a *nested imported* component, so
  Angular reports `NG0303: Can't bind to 'x'`; the binding never lands, and the
  required input then throws `NG0950` **during change detection**, taking down
  the **host** spec rather than the child's. Prefer `input<T>(default)` — the
  better contract anyway. Two consecutive CI failures on PR #252 came from not
  knowing this.
- **Call `setInputValue` before the fixture's first `detectChanges()`.** The raw
  `.value` write bypasses `signalSetFn`, so anything that already read the
  signal is never notified and keeps rendering the stale value.
- **One fresh component per scenario.** Same mechanism: a second write to the
  same input lands in the node but doesn't invalidate readers, so an assertion
  after it can silently check the *first* value.

This exercises the real production template/CSS — it only swaps out *how* the
input value gets in.

## Now Playing waveform + karaoke VFX (issue #643)

Two visual surfaces fed by one precomputed artifact, `GET /api/peaks/:id` → `WaveformData`
(`@nicotind/core` `types/waveform.ts`): a ≤600-pair min/max envelope and a 4 fps six-band energy
timeline (sub-bass … high, 0..1 relative to the track's loudest frame-band).

**Why precomputed, and not a live analyser.** `player.component.ts` documents the prohibition:
routing the `<audio>` element through `MediaElementAudioSourceNode` silenced playback on Android.
There are also *two* `<audio>` elements that swap for gapless playback, so a one-time
`createMediaElementSource` would stop feeding data after the first swap. A fetched artifact is
deterministic (every device draws the same frame for the same moment), works offline and under the
transcode path, and exists before playback starts.

**Why sidecar-free.** The artifact needs no Essentia: one streaming ffmpeg decode (`streamPcm`, the
spawn path `decodePcm` now shares — a 60-minute mix is 635 MB as Float32, so the reducer is fed in
chunks and never holds the track) through the pure `services/waveform-reduce.ts` (sample-by-sample,
so the result is identical however the chunks are sliced; a ~40-line radix-2 FFT at 4096 points
gives the 20–60 Hz band real bins). It therefore ships on streaming-only installs and does not
depend on the descriptors store (docs/audio-descriptors.md). Generated **on demand** in the route
handler — the `getTranscodedFile` precedent — and cached content-addressed on disk
(`services/waveform-store.ts`; see cache-invalidation.md for the key and the negative cache).

**The strip** (`NowPlayingWaveformComponent`, pure `lib/waveform-geometry.ts`): a static SVG above
the seek bar in the sheet's transport. No per-frame work — progress is a CSS `clip-path` on the
played overlay, so playback costs nothing. It is **decorative and tap-to-seek only**: `aria-hidden`,
never a focus stop (a focusable strip would be one more thing eating arrow keys on TV, #438), and
the native `<input type="range">` stays the accessible, keyboard and D-pad control — the decision
recorded in `seek-bar.component.ts` is untouched. Now Playing only, by decision: the mini-player
strip is ~4 px tall and track rows would need a batch fetch. Not rendered on the TV build
(`isTv`), whose player has no seek bar at all.

**The box is reserved from the first paint (issue #657).** The artifact is decoded on demand, so a
track's first play waits 1–3 s. The strip originally rendered nothing until the response landed —
deliberately, so no space was held for a waveform the server might never provide — but the cost was
a 40 px growth that pushed the seek bar, the time labels, the transport buttons and the
Queue/Lyrics panel down, on every cold track *and* on every skip (`loadWaveform` clears the signal
before each fetch). The strip's height never depended on the data: it is a fixed `h-10` box over a
`0 0 600 48` viewBox stretched with `preserveAspectRatio="none"`.

So both states now occupy that same box and `data-state` on the root `<svg>` cross-fades between
them (rules in `styles.css`, next to the skeleton ones): a **flat baseline bar** at rest, the
**envelope** once it lands, the envelope growing out of the line over 180 ms rather than replacing
it. Consequences worth knowing:

- **A missing waveform is a permanent flat strip, not a collapse** — the chosen trade-off. A 404
  (no ffmpeg, unreadable file, decode failure) leaves a dim hairline where the envelope would be,
  which is why the baseline carries the played-progress overlay too: the resting state stays
  informative rather than reading as a broken element.
- **Both layers stay mounted.** A layer inserted by an `@if` arrives already in its final state,
  with no previous computed value to transition from, so it would snap rather than fade. The
  envelope's `d` is absent (not empty) while there is no data — `path[d]` is the selector that
  distinguishes the states in a test.
- **The whole strip is tappable in both states**, because the handler sits on the always-rendered
  `<svg>`. Tap-to-seek no longer depends on whether the decode has returned.
- Motion is dropped under `prefers-reduced-motion` and on the eink theme, by the same test the
  skeleton rules pass: the strip is legible in both states with the transition frozen.

**The VFX** (`NowPlayingVfxComponent`, pure `lib/vfx-scene.ts`): a `<canvas>` behind the karaoke
fullscreen's content, six glowing orbs laid out by musical role (bass low, central and large; highs
small near the top), radius and alpha driven by the band levels under the playhead
(`bandLevelsAt`, linear between frames), drifting on slow sines of `t` so a sustained level still
breathes. One `requestAnimationFrame` loop per play session inside an `effect` with
`cancelAnimationFrame` on cleanup (the remote-position interpolation's lifecycle); while paused a
single frame is painted. The playhead between `timeupdate`s is extrapolated on the wall clock and
re-anchored on every update. A null 2D context (jsdom, headless) is a no-op frame, never a throw.
`lib/vfx-scene.ts` is the one place to change the look — the component only paints shapes.

**Fetch lifecycle.** The shell (`now-playing.component.ts`) fetches `getPeaks` lazily, like lyrics:
only while the sheet is open and the track changed, with a late-response guard so a slow decode for
a track you've already skipped past can't paint over the current one. Plain `HttpClient` JSON —
`ngsw-bypass` is only for media Range requests.

## List loading skeletons

Every list view that fetches data renders a **shape-matched skeleton** while it
waits, via one `SkeletonComponent` (`components/skeleton/`). Before this, all of
them rendered the same copy-pasted spinner —
`border-2 border-theme border-t-zinc-300 rounded-full animate-spin` — centred in
`text-center py-20` dead space as a *sibling* of the grid it stood in for. That
string appeared twelve times across seven templates, and a 5-column poster wall
resolved out of an empty page, so the layout jumped hard on arrival.

### The split rule (why some spinners stayed)

> A **spinner** means an action the user started is in progress.
> A **skeleton** means content is coming and its shape is already known.

Applied honestly, that leaves a lot of spinners in place. The ones deliberately
**not** migrated, and why:

| Site | Why it stays a spinner |
| --- | --- |
| `admin.component.html:1` | Not a spinner at all — a `<p>{{ 'admin.loadingUsers' \| t }}</p>`. It also stands in for a whole *settings page* (five group cards, metric pills, a log viewer, three tables), not a list. **A `<div>` row stack cannot match a `<table>`'s auto-layout column widths**, so a table skeleton would jump — which is why there is no `table-row` variant. |
| `search.component.html` `resolvingAlbum()` overlay | An action on one specific card. |
| `search.component.html` peer/track counter | Live progress with an incrementing count — reporting, not placeholding. |
| `album-hunt-modal` (searching, "Queuing downloads…") | Process reporting with a per-query phase list. |
| `downloads.component.html:14`, `admin.component.html:69` | Scan-in-progress icons next to a live song count. |
| `artist-image-menu`, `folder-browser` | Upload / fetch in flight. |
| `song-picker` "Searching…" | Debounced typeahead — a skeleton would strobe on every keystroke. |
| `playlist-detail` proposals | That section legitimately renders *nothing* when there are no proposals; a skeleton would promise content that often isn't coming. |
| `radio-landing` vibe presets | Per-button in-progress. Its genre chips have no loading state and keep none: `@if (genres().length > 0)` means absent-not-empty, and there is no `currentTrack`-style proxy to tell "will be non-empty" from "will stay empty". |
| `track-row`, `player-*`, `now-playing-*`, `layout` | Buffering and pull-to-refresh — these encode *state* in their motion. |
| `library.component.html` `.animate-loading-bar` | Already not a spinner, and it reads "fetching more". |

`pages/page-shell.spec.ts` guards the migrated set against regrowth and carries
that exclusion list inline, so it can be audited rather than just trusted.

### Variants

Each variant owns **both** its container classes and its item markup, so
shape-matching is a property of the component rather than of the caller. A
primitive that call sites assembled into grids would recreate the copy-paste as
a dozen hand-built placeholder blocks drifting from the lists they mirror.

**The host element *is* the container** — `<app-skeleton>` carries the grid/stack
classes itself and drops into the same DOM position as the real list container,
with no wrapper div. Consequence: every variant's class string must begin with an
explicit display class, because an unknown element is `inline` by default and a
stacked variant would silently lose its vertical rhythm. There is a spec for it.

| variant | container | default count | mirrors |
| --- | --- | --- | --- |
| `album-tile` | `grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4` | 10 | Albums / Singles / Compilations, discography, find |
| `artist-tile` | same 5-col grid | 10 | Artists tab |
| `genre-tile` | `grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3` | 8 | Genres tab |
| `track-row` | `block space-y-0.5` | 8 | every song listing |
| `shelf-tile` | `flex gap-3 overflow-x-auto pb-2 -mx-1 px-1` | 6 | Recently played |
| `detail-header` | `flex flex-col sm:flex-row items-center sm:items-end gap-6 mb-8` | 1 | album / playlist / share |
| `artist-header` | `flex items-center gap-5 mb-8` | 1 | artist page |

Inputs: `variant`, `count` (clamped 1..60; header variants ignore it), `label`,
`containerClass` (replaces the default wholesale — search's catalog grid is a
narrower column scale than the library's, and is the one call site that needs
it), `trackCover` (mirrors `TrackRowComponent.showCover`; the album page passes
`false`), `testId`. **No input is `input.required`** — a required input on a
nested component throws `NG0950` under the JIT vitest harness and takes down the
*host page's* whole spec (see `src/testing/signal-input.ts`), and this renders
inside `LibraryComponent` and friends, all of which have full-template specs.

### The line-height ledger (what makes shape-match real)

> A text placeholder is a short bar **vertically centred in a box of the real
> element's line-height** — never a bar of arbitrary height.

`text-sm` = 20px, `text-xs` = 16px, `text-2xl` (`page-title`) = 32px. Worked
example, `album-tile` against `library.component.html`:

```
p-3 (12) + cover + mb-2 (8) + 20 (text-sm title) + 16 (text-xs subtitle) + p-3 (12)
```

which is the real tile exactly, so the grid does not reflow when data lands.
`Components/Skeleton` → `ShapeMatchAlbumGrid` and `ShapeMatchTrackList` put real
content beside the skeleton in one container; if the rows stop terminating at the
same y-offset, a ledger is wrong and that is where it shows.

One deliberate approximation: `share-view` renders its own rows (`px-2 py-3`, no
cover) rather than `TrackRowComponent`, so its row pitch is close but not exact.
Not worth an eighth variant for one public page.

### Motion

**Opacity 1 → 0.6, 1.8s, `ease-in-out`**, defined once on `.skeleton-block` in
`styles.css` — not Tailwind's `animate-pulse`. Four reasons, in order of weight:

1. `animate-pulse` is `1 → .5 → 1` on `cubic-bezier(0.4, 0, 0.6, 1)`, a curve
   that *decelerates into* both extremes and so dwells at the trough — it reads
   as a flash. `ease-in-out` sweeps through the minimum, so at the same nominal
   amplitude it reads as a breath.
2. One selector must own colour, animation and the reduced-motion opt-out
   together, or a call site can render a themed block and forget the animation.
3. The block colour has to be a theme token anyway, so a CSS rule exists either
   way.
4. One place to retune amplitude app-wide.

`.skeleton-block-soft` mixes toward the page background for secondary lines, so a
tile reads as a hierarchy rather than a solid slab.

**Caveat:** these rules are *unlayered* (matching `.animate-loading-bar` and
`.eq-bars` in the same file), so they beat Tailwind's `@layer utilities` — a
`bg-*` utility on a `.skeleton-block` silently loses. Set tone with
`skeleton-block-soft`, never a Tailwind bg class.

**Sync.** CSS animations start at the first style flush after the element enters
the render tree, and Angular's `@for` materialises every item in one
change-detection pass — so all placeholders mounted by the same `@if` flip share
a start time and pulse in lockstep. That synchrony is what makes a page of
skeletons read as one surface. **Never add an `animation-delay`** (that is the
`.eq-bars` idiom and the opposite of what this wants), and **never render a
skeleton adjacent to one already animating** — they would be out of phase. The
two "load more" call sites are safe by construction: they render below
already-loaded real rows, never beside a running skeleton.

**Reduced motion.** This is the app's *first* `prefers-reduced-motion` rule, and
it is scoped to skeletons rather than a blanket `* { animation: none }` on
purpose: the buffering spinner, `.eq-bars` and `.animate-loading-bar` all encode
state in their motion, so freezing them destroys information. A skeleton's motion
is decorative — the shape already says "loading". The eink theme freezes it too,
because e-paper ghosts on repaint.

### Accessibility

The whole contract is the pure `skeletonAria(label)`:

| `label` | host attributes |
| --- | --- |
| non-empty | `role="status"`, `aria-busy="true"`, `aria-label="<label>"` |
| empty (default) | `aria-hidden="true"` |

The two are mutually exclusive by construction — a hidden live region is a
contradiction, and there is a spec asserting they never co-occur.

Why this survives `a11y:storybook:strict` at zero: placeholder blocks contain
**no text nodes**, so `color-contrast` never applies. That is the reason the name
comes from `aria-label` rather than an `.sr-only` string — a clipped text node is
exactly what axe reports as a contrast *incomplete*, and the strict gate is
per-rule, not per-severity. `aria-hidden-focus` only fires on focusable
descendants, and a spec asserts every variant renders none.

**Composition rule:** when a page renders two skeletons (a header plus its list),
only the **first** takes a `label`. Two live regions on one screen compete. This
is also why `label` must not be required.

**Honest limitation:** a live region inserted into the DOM at the same moment its
content appears is announced unreliably across screen readers. This is still
strictly better than the bare `<span>` spinner it replaced, which was 100%
silent. Don't paper over it with a delayed live region — that is a second
mechanism to maintain.

### Drift guards

- `components/skeleton/skeleton-shape.spec.ts` — reads the real page templates
  off disk and asserts each variant's container string still appears in the list
  it mirrors. Same idiom (and the same class-order-sensitivity caveat) as
  `page-shell.spec.ts`.
- `pages/page-shell.spec.ts` — the migrated templates must not regrow the spinner
  literal, and must render an `<app-skeleton>`.

## Changelog Modal

Clicking the version string in the **desktop header** (`layout.component`, `data-testid="version-changelog"`) or the **Settings page footer** (`settings.component`, `data-testid="version-changelog-settings"`) opens a scrollable modal showing the project's release history — versions, dates, and commit links from `CHANGELOG.md`.

- **Component**: `packages/web/src/app/components/changelog-modal/changelog-modal.component.ts` — hand-rolled modal (same overlay/ESC/backdrop-dismiss pattern as `confirm-dialog`), pre-computes parsed items on init.
- **Item parser**: `packages/web/src/app/lib/changelog.ts` (`parseChangelogItem`) — pure, unit-tested function that splits a `commit-and-tag-version` bullet into `{ scope?, description, commitSha?, commitUrl? }`. The scope (`**scope:**`) is rendered in bold; the commit SHA is a clickable external link.
- **Data source**: `packages/web/public/changelog.json` — a build artifact generated by `packages/web/scripts/build-changelog.ts`, which parses `CHANGELOG.md` (the `commit-and-tag-version` output: `## [version] (date)` → `### Section` → `* item` bullets) into the JSON shape consumed by the modal. **Capped at 50 versions** (newest-first); raw dates preserved as-is (`2026-07-02`).
- **Build wiring**: `prebuild`/`pretest` scripts in `packages/web/package.json` run the generator before every `ng build`/`test`. The modal imports the file as a **static ES module**
  (`import changelog from '../../../../public/changelog.json'`), so `tsc --build`/`typecheck:template`/vitest's transform all need it present on disk *before* they run — and none of those three has a
  generation hook of its own, unlike `build`/`test`. That means the file **must stay checked in** despite being a generated artifact: a `.gitignore` entry for it (`packages/web/public/changelog.json`)
  had existed since some earlier commit but was inert (the file was already tracked when the entry was added, and `.gitignore` never untracks an already-tracked file) — the entry has been removed now
  that this is understood, so the repo state matches what the ignore rule always silently failed to achieve. `build-changelog.ts` writes only when its output actually differs from what's already on disk
  (`writeIfChanged`), so a no-op regeneration (the common case — `CHANGELOG.md` hasn't moved since the file was last committed) never dirties the git working tree.
- **Docker build context (gotcha)**: because the generator reads repo-root `CHANGELOG.md` at build time, the file **must reach the Docker build context**. `.dockerignore` excludes all `*.md`, so it carries an explicit `!CHANGELOG.md` un-ignore, and the `web-builder` stage `COPY CHANGELOG.md ./` before `bun run build`. Miss either and `build-changelog.ts` silently writes `[]` (`existsSync` fallback), so the modal opens **empty in the browser webapp** while the locally-built Capacitor app (full repo present) still works. Guarded by `packages/web/src/app/lib/docker-changelog-context.spec.ts`, which emulates the `.dockerignore` filtering + asserts the `COPY`. (Fixed after the initial changelog-modal ship; the first Docker fix only silenced the crash, not the empty output.)
- **Stale `CHANGELOG.md` in dev**: `CHANGELOG.md` only updates on `bun run release` (CI release job). Between releases the embedded JSON reflects the last release's changelog; the `package.json` version (shown as `v{version}`) advances independently via the release commit. This is the same build-time-bake pattern as `APP_VERSION` (which imports `package.json` at build time).
- **API version**: `GET /api/system/status` `nicotind.version` is read from `package.json` at server startup (`src/main.ts` → `createApp({ version: pkg.version })` → `systemRoutes`), replacing the previous hardcoded `'0.1.0'`.
- **GitHub Release description (second `CHANGELOG.md` consumer)**: the `release-notes` job in `.github/workflows/deploy.yml` (ungated by `changes`, `if: github.ref_type == 'tag'`) `awk`-extracts the tag's `## [<version>] …` section from `CHANGELOG.md` and sets it as the Release description via `softprops/action-gh-release` (`body_path`). It only sets `body`, so it merges with — never clobbers, and is never clobbered by — the asset-upload steps that pass no body, in any job order. Empty section (chore/refactor-only release) → a "Maintenance release" fallback so the Release page is never blank.

## Manual PWA update check

The Angular service worker (`provideServiceWorker('ngsw-worker.js')`, registered via `registerWhenStable:30000`) ships in every production browser build. It only re-checks `/ngsw.json` on initialization and on navigation requests — Chromium self-schedules around 24 h, so a user who keeps the tab open for the whole weekend between NicotinD releases sees the new **Reload to update** banner only when they navigate or open a new tab. The first symptom reported in real use was "I deployed a new version and my browser kept showing the old one", then "I had to reload manually to even see the toast". The fix is `UpdateService.checkForUpdate()`, wired into a Settings → Account **Check for updates** button (`data-testid="settings-check-update"`).

**Pool and isolation (measured).** `pool: 'threads'` + `maxWorkers: '100%'` took the suite
from 134.7s to 113.1s; nothing here needs process isolation, so `forks` was pure spawn
overhead. `isolate: false` is the much bigger lever — **14.1s**, a 9x win, because
`test-setup.ts` imports `@angular/compiler` and that is re-evaluated for each of the 193
spec files — and it is deliberately **not** taken: three specs in
`desktop-window-controls.component.spec.ts` need `vi.mock` of `lib/platform` to resolve
per-file, and a shared module registry breaks that. Two *real* bugs it surfaced were
fixed rather than left: `platform.spec.ts` and `native-capabilities.spec.ts` swapped the
global `window` for stubs and then `delete`d it instead of restoring the real one, which
is a latent landmine under any shared-worker config. Re-evaluate behind
`bun run check:isolated-specs --web`; `web-test` is its own CI job now, so the remaining
2 minutes are off the critical path.

### Design

- **Service**: `UpdateService` (`packages/web/src/app/services/update.service.ts`) bridges Angular's `SwUpdate` to signals. Exposes:
  - `enabled: Signal<boolean>` — `SwUpdate.isEnabled` **or the native Android APK path** (see below; false in dev, Electron, iOS, browsers without SW support).
  - `updateAvailable: Signal<boolean>` — sticky `true` once `VERSION_READY` fires (existing).
  - `searching: Signal<boolean>` — gates duplicate clicks while a check is in flight.
  - `checkAvailable: Signal<boolean>` — `enabled && !updateAvailable`; the manual control only renders when this is true (the banner already owns the CTA once an update is staged).
  - `checkForUpdate(): Promise<'available' | 'up-to-date' | 'unavailable'>` — short-circuits to `'unavailable'` when `!enabled` or already `searching`; otherwise calls `sw.checkForUpdate()` (resolves `true` if the new version is downloaded & ready, `false` otherwise; rejects on a network/SW error) and returns the result.
  - `applyUpdate(): Promise<void>` — `sw.activateUpdate()` then `document.location.reload()` (unchanged; jsdom doesn't allow redefining `location.reload`, so the test asserts the call against the stub).

- **UI** (`packages/web/src/app/pages/settings/settings.component.{ts,html}`): the Account section grows a `@if (update.checkAvailable()) { … }` button. On browsers it follows `SwUpdate.isEnabled` (so dev builds and Electron hide it); on the native Android/TV shell `enabled` is true via the APK path instead. It shows **Check for updates** by default and **Checking for updates…** + `disabled` while the check is in flight.

- **Outcomes → toasts** (existing `ToastService`, no new component):
  - `'up-to-date'` → green `"You're on v{version}"` toast (3 s).
  - `'available'` → blue toast (8 s) with **Reload** and **Later** actions; **Reload** dismisses the toast and calls `applyUpdate()`. The sticky banner appears once `VERSION_READY` fires anyway — the toast is the immediate feedback, the banner is the universal CTA.
  - error → red `"Couldn't check for updates — try again later."` toast.
  - Stale toast from a previous check is dismissed on a new click.

- **Parity matrix across releases**:

  | Surface | Update mechanism | "Manual check" affordance | PWA fallback path |
  |---|---|---|---|
  | **PWA (web)** | Angular service worker + `SwUpdate` | `Check for updates` button → `UpdateService.checkForUpdate()` | Banner (`UpdateBannerComponent`) owns `applyUpdate` once `VERSION_READY` |
  | **Electron** (`packages/desktop/electron/updater.ts`) | `electron-updater` polling GitHub Releases (`updateMode(platform, signed)`: Linux AppImage = apply, macOS = notify-only) | Native `dialog.showMessageBox` on `update-downloaded` / `update-available`; auto-downloaded by electron-builder's `--publish always` | User opens **Releases page** link |
  | **Capacitor Android / TV** | **In-app APK self-update from GitHub Releases**: `checkForUpdate()` reads `releases/latest`, compares via the shared `compareVersions` (`@nicotind/core`), and `applyUpdate()` has the `NicotindApkUpdate` plugin download the flavor-matched asset (`NicotinD[-TV]-<v>.apk`, chosen by `isTvUi()`) and open the system installer — see [docs/mobile-app.md](mobile-app.md) "Self-update from GitHub releases" | Same `Check for updates` button (the toast offers **Install** instead of Reload; a `settings-update-progress` line shows download %) | The system installer owns the final accept/deny |
  | **Capacitor iOS** | **No OTA** — reinstall the IPA from GitHub Releases | None — the button stays hidden (`enabled` is false off Android) | — |

  The reason the manual check is a *button* rather than a *timer*: Angular's docs explicitly warn that long-running `setInterval` polling (the canonical "check every 6 h" snippet) **prevents the app from stabilizing and delays SW registration up to 30 s** (`ngsw-config.json` + `provideServiceWorker`). A user-triggered click is both the cheapest and the safest fix. Every NicotinD release already triggers a `chore(release):` commit and pushes a `vX.Y.Z` tag, so the SW's natural polling cadence is fine when the user actually opens the tab — the bug only surfaces for users who stay parked on the same tab for hours.

### Alternatives considered (and rejected)

1. **Background interval polling** (`interval(6h)` → `checkForUpdate()` from the Angular docs). Rejected: blocks SW registration (the registration *forces* at 30 s when there's a polling task alive) and costs N requests/day per open tab for a payload that almost always says "no update". Manual click is on demand.
2. **Compare `/api/system/status` `nicotind.version` vs `APP_VERSION` client-side and toast on mismatch.** Rejected: the server version advances with the Docker image, not the deployed PWA assets. A fresh image with the old `dist/` would toast "new version" even though the SW has nothing to swap to. `SwUpdate.checkForUpdate()` is the authoritative "new app shell available" signal.
3. **`sw.unrecoverable` event → reload prompt.** Out of scope for this fix (would need a recovery UI + a "wipe cache" CTA); left as a follow-up if/when a real "stuck cache" report lands.

### Files touched

- `packages/web/src/app/services/update.service.ts` — added `enabled`, `searching`, `checkAvailable`, `checkForUpdate`.
- `packages/web/src/app/services/update.service.spec.ts` — 11 tests: enable/disable, search guard, available/up-to-date/error outcomes, reentrant safety, `applyUpdate` activation.
- `packages/web/src/app/pages/settings/settings.component.ts` + `.html` — `searchForUpdates()` + `reloadToUpdate()` handlers; new `@if` button above the version chip.
- `packages/web/src/app/pages/settings/settings.component.spec.ts` — 8 new tests (visibility: enabled/disabled/staged; outcomes: up-to-date/available/error; re-entrancy via toast dismiss; pending-state UI).
- `packages/e2e/tests/pwa-update.spec.ts` — chromium-only assertion that the button **is visible** on the e2e server. The harness serves the **production** `@nicotind/web` bundle (`ng build` defaults to the production configuration with `serviceWorker: ngsw-config.json`) over http://localhost, where Chromium permits service workers — so `sw.isEnabled` is true and `checkAvailable()` resolves true, proving the `@if` gate renders the control in a real PWA build. The toast outcomes are covered by the unit tests because `SwUpdate` cannot be stubbed from outside the bundle, and driving the live SW round-trip through Playwright would hinge on flaky service-worker registration timing.
- `CLAUDE.md` (one-line index pointer) + this section.

### Gotchas

- **jsdom doesn't let you redefine `window.location.reload`**, so the `applyUpdate` test asserts against the stub's `activateUpdate` instead of intercepting the navigation (`update.service.spec.ts`); production behaviour is unchanged.
- **Don't poll**: a `setInterval` (or `interval(...)`) keeps the app from stabilizing and the SW registration would force at 30 s (`registerWhenStable:30000`). The Angular docs' canonical example waits for `ApplicationRef.isStable` before starting the timer; for now the click handler is the entire solution.
- **`ngsw-bypass` still applies**: the stream URL helper (`ServerConfigService.streamUrl`) appends `ngsw-bypass=1` so `/api/stream/*` never hits the worker — orthogonal to this change but worth keeping in mind when reasoning about "the SW isn't picking up the new version".

## Service worker fire-and-forget

## Bundle size budget (issue #256)

`packages/web/angular.json` carried the **untouched Angular CLI scaffold defaults**
(`initial` 500 kB warning / 1 MB error), which the app has exceeded for long enough that the
warning became part of expected build output. A warning that is always red is a warning nobody
reads — the real cost is that the next genuine regression looks identical to the status quo.

**Measured before deciding.** `ng build --stats-json`, attributing `bytesInOutput` for the
initial chunk:

| | raw | transfer |
| --- | --- | --- |
| initial total | 734.78 kB | **187.63 kB** |

| package | initial chunk |
| --- | --- |
| **@sentry/\*** (replay 124 + core 85 + browser-utils 30 + browser 29 + angular 4) | **272 kB** |
| @angular/core | 142 kB |
| @angular/router | 77 kB |
| **app code** | **72 kB** |
| @angular/common | 26 kB |
| rxjs | 21 kB |

Two things that decide the question:

1. **The budget measures raw bytes; users pay transfer.** 735 kB raw is 188 kB over the wire,
   which is unremarkable for an app of this scope. "47 % over budget" was measuring the wrong
   number against a threshold nobody chose.
2. **42 % of the initial chunk was Sentry — now lazy-loaded (issue #285, resolved).** When #256
   raised the budget, Sentry was eager: `main.ts` called `initSentry` *before*
   `bootstrapApplication` to catch startup failures, and `app.config.ts` needed it statically
   for the `ErrorHandler` + `TraceService` providers. #285 removed all three static references —
   the SDK is reached only via `import('@sentry/angular')` inside `loadSentry`, so esbuild splits
   its ~272 kB into a lazy chunk. Startup-error capture is preserved by a synchronous
   `error-buffer.ts` + `BufferingErrorHandler` that replay into the SDK once it connects, so the
   property that motivated the eager init survives without the first-paint weight. `TraceService`
   was dropped (only Angular-router spans lost). See [docs/observability.md](observability.md).

The budget was raised to **780 kB** (current + ~6 % headroom, tight enough that real growth trips
it — verified it still fires: set to 700 kB, the build correctly warns; `maximumError` stays at
1 MB). It is deliberately **left at 780 kB** even though #285 freed ~272 kB of raw initial: the
budget is a ceiling with headroom, and lowering it to hug the post-#285 figure would just re-trip
on the next feature. The win is a smaller *actual* initial chunk, not a tighter budget.

**`qrcode` is now lazy.** It was a static import in `devices.component.ts`; it is now
`await import('qrcode')` inside `renderQr`, which took the devices route chunk from **38.9 kB
to 14 kB** and moved the library into its own 24 kB chunk fetched only when a pairing QR is
actually minted. This does **not** silence the "not ESM" warning — that is CommonJS interop and
is unaffected by import style; a dynamic import in fact surfaced a second one (`dijkstrajs`).
Those two are declared in `allowedCommonJsDependencies`, which is Angular's sanctioned way to
acknowledge a known CJS dependency, so the build is now **warning-free** and the next warning
means something. Note the trade: a broken static import fails the build, a broken dynamic
import fails at click time — hence `devices.component.spec.ts` covers the QR path.

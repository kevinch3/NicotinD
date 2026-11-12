# Web UI

Angular v22 standalone SPA with signals (`signal()`, `computed()`, `effect()`), `HttpClient` + interceptors, and Angular Router with lazy-loaded routes. Built via `ng build` (esbuild); tests via `ng test` (vitest, integrated via `@angular/build:unit-test`).

## Theme System

CSS custom properties set via `[data-theme]` on `<html>`. Seven built-in presets: **Midnight** (default), **Daylight**, **Warm Paper**, **OLED Black**, **Twilight**, **Forest**, **E-Ink**. Theme is persisted to localStorage (`nicotind-theme`) and applied before first paint (inline script in `index.html`) to avoid flash. **The pre-paint script keeps its own `THEMES` allowlist in sync with `THEME_PRESETS`** — a missing id falls back to `midnight`, so an omitted theme (e-ink was the bug) flashes the default and renders wrong on first paint until hydration.

- Theme service: `packages/web/src/app/services/theme.service.ts` (Angular `signal()` + localStorage)
- Token definitions: `packages/web/src/styles.css` (`@layer base` — `:root` + per-`[data-theme]` overrides)
- **Themed utilities**: semantic classes map tokens to Tailwind (`bg-theme-surface`/`-surface-2`/`-hover`/`-base`, `text-theme-primary`/`-secondary`/`-muted`, `border-theme`). The **accent** utilities (`bg-theme-accent`/`text-theme-accent`/`border-theme-accent`) and a **neutral primary-button** pair (`bg-theme-inverse` = `--theme-text-primary`, `text-theme-inverse` = `--theme-bg`) are defined with Tailwind v4 `@utility` (so `hover:`/`focus:` variants work). **Primary/CTA buttons on themed surfaces must use these, not hardcoded `bg-zinc-100 text-zinc-900`** — the latter is white-on-white on light themes (Daylight/Warm Paper), and `bg-theme-accent` was previously _referenced but never registered_, so accent-filled buttons silently had no fill. **Text/icons painted on a `bg-theme-accent` fill (the nav download-count badges) must use `text-theme-on-accent`** — a per-theme `--theme-on-accent` foreground chosen to contrast each accent (light text on the dark-ish indigo accents, dark text on the light teal/violet/amber ones). The badges previously used `text-theme-base`, which was _never registered as a text utility_ (only `bg-theme-base` exists), so the number inherited an arbitrary colour that didn't contrast the accent pill. `bg-theme-inverse` flips per theme (white button on dark themes, dark button on light) so it stays visible while preserving the dark-theme look. **Exception**: the fixed-dark auth screens (login, setup, server-config, pair, invite, reset/forgot password, verify email) are intentionally always-dark and keep their `bg-zinc-*` palette. **Search is no longer in this exception** (#1685): its fixed-dark input was a black slab on the light presets, so it now follows the active preset like the rest of the app. Inside a cover's `bg-black/60` busy scrim the spinner and label are `white/*` literals, which read on black in every preset. The shared `PasswordFieldComponent` sits on both sides of that line, so its show/hide toggle paints in `currentColor` (`text-current`, `hover:bg-current/10`) rather than in either palette. `src/theme-holdouts.spec.ts` fails on any `*-zinc-NNN`/`*-indigo-NNN` utility outside an allowlist that names each exception and its reason, and fails again when an allowlisted file no longer needs its entry. **Now Playing is no longer in this exception** (issue-driven Task 10 of the player-standardization plan, 2026-08): the shell and all 7 extracted sub-components (see "Now Playing — component split + tabbed Queue/Lyrics panel" below) were migrated onto theme tokens (`bg-theme-base`, `text-theme-*`, `bg-theme-accent`, etc.) and now follow the active preset like the rest of the app. The one deliberate holdout is the **fullscreen karaoke overlay** (`NowPlayingKaraokeFullscreenComponent`), whose background is a dynamic gradient computed from the track's cover art (`lib/cover-colors.ts`) — an app theme would fight that gradient, so its text/controls stay literal `text-white/*` against it, same as before. **Coloured accent chips (the blended-results `app-source-chip` per-source tones) must also be theme-aware**: they use `.chip-tone-{soulseek,archive,spotify}` in `styles.css`, which derive both the tint (`color-mix(hue 16%, --theme-surface)`) and the text (`color-mix(hue 60%, --theme-text-primary)`) from the active theme tokens — so the text lightens on dark themes and darkens on light ones. The prior hardcoded `bg-indigo-500/15 text-indigo-300` (and amber/emerald `-300` tints) rendered near-invisible on light themes (Daylight/Warm Paper/E-Ink); the same rule applies to the catalog **artist pills** on Search, which now use `border-theme text-theme-secondary hover:border-theme-accent hover:text-theme-primary` instead of hardcoded `zinc`. The source → class map is the pure, unit-tested `sourceChipToneClass()`. **Semantic status colours** live on the same token system: each theme defines `--theme-status-{progress,done,warn,error}-{bg,text}` (the `warn`/amber role was added alongside the existing three), surfaced as `.status-*` (filled pill = bg+text) and `.text-status-*` (label only) utilities. **Status/warning text on a themed surface must use these, not hardcoded `text-amber-400`/`bg-emerald-500/20 text-emerald-400`/etc.** — those `-400` tints go near-invisible on the light themes; the tokens flip to dark text + light bg there. A codebase-wide audit (2026-07) also **registered a batch of themed utilities that were referenced but never defined** (silent no-ops): `border-theme-surface-2`, `divide-theme-surface-2`/`-border`, `border-theme-secondary`, `ring-theme-bg`/`-accent`, `accent-theme`/`-secondary`; and **migrated the former hardcoded `bg-zinc-*/text-zinc-*` "dark-island" components** (`track-context-menu`, `device-switcher`, `track-info-sheet`, the plugins page, the admin page) onto the theme tokens so they follow the active preset instead of floating as dark panels on light themes. The always-dark exceptions above still keep `bg-zinc-*`; modal scrims (`bg-black/60`), small solid indicator dots, and the destructive `bg-red-600 text-white` confirm button are intentionally left literal. Guarded by `packages/e2e/tests/theme.spec.ts` (probes the computed colours on Daylight/OLED). **The `status-*` family is also registered in `@theme`** (`--color-status-{progress,done,success,error,warn}`, each aliasing that theme's status _text_ token): the static `.text-status-*` classes only cover the plain no-variant case, so `bg-status-success` / `bg-status-error/15` / `hover:bg-status-error/10` were referenced at three call sites while Tailwind emitted **no rule at all** for them — the same silent-no-op shape as `bg-theme-accent` above, and the reason the (since removed) review inbox's `bg-status-success … text-white` Approve button rendered white-on-white on every light theme (issue #591). Registration makes the whole `bg-`/`border-`/opacity-modifier family resolve; a **filled** control should still prefer the `.status-*` pill class, which pairs bg+fg per theme, over `bg-status-*` + a hardcoded `text-white` (white on the dark themes' light-green `--theme-status-done-text` would fail contrast).
- **Elevation + glass tokens (#1638)**: `--theme-elevation-tile`/`-raised`/`-overlay` (box-shadow values), `--theme-glass-edge` (the hairline a translucent panel needs over artwork), `--theme-elevation-up` (a layer floating over content above it: the mini player) and `--theme-glass-alpha` (how much surface a `.glass-panel` keeps). One set for the dark themes on `:root`, one for Daylight/Warm Paper — a shadow that reads on Midnight is a smudge on Daylight — and none on E-Ink (no shadows, glass alpha `100%`). `--theme-glass-alpha` is a **per-theme contrast floor**, not a style: it is the least surface that holds secondary text at 4.5:1 over pure white _and_ pure black, which ranged from 80% (Daylight) to 93% (Twilight) when measured, so Twilight and Forest override the default. `src/theme-glass.spec.ts` reads `styles.css` and checks every palette, so a new theme or a palette change cannot quietly break it. `.glass-panel` goes opaque under `prefers-reduced-transparency`, on E-Ink, and where `backdrop-filter` is unsupported.
- **Token pass, slice (a) (#1684) + the contrast table**: following the theme audit's owner answers ([theme-audit.md](theme-audit.md), Q1 A), every preset defines a second hue, `--theme-accent-2` / `-accent-2-text` / `--theme-on-accent-2`, for "now playing / live", so the accent keeps "press me" and "you are here". It's coral on the dark presets, burnt orange on Daylight, teal on Warm Paper (whose accent is already amber), and black on E-Ink. `--theme-surface-1` is a new name for `--theme-surface` (aliased once on `:root`). All four are registered in `@theme`, and Tailwind emits their utilities on first use. Nothing uses them yet, so the slice changes nothing on screen except the two audit failures it fixes: Forest's secondary text (`#7dac98`, 4.59:1 on `surface-2`) and Warm Paper's accent (`#d27306`, 3.15:1 as a fill on `bg`, with `on-accent` at 4.62:1). The widened surface ramp, `surface-3` and the tinted neutrals wait for #1683, because muted and accent text sit at about 4.5:1 on `surface-2` and have to move with any lighter level. `theme.spec.ts` "theme contrast table" reads every preset's computed tokens and fails on any pair under target (4.5 for text, 3 for a fill), with pills composited over `surface`. `theme.service.spec.ts` keeps the `theme-color` meta table equal to each preset's accent: it had drifted to `#6366f1` on Midnight and Daylight.
- **A `/NN` opacity modifier needs an `@theme` colour (#1640)**: Tailwind v4 resolves `bg-x/50` only for a colour registered in `@theme`; a name that exists only as a static class emits **no rule at all**, silently. `theme-surface-2`, `theme-base` and `theme-hover` were static-only, so 23 uses were inert — the mosaic's view switch rendered transparent over the tiles, the header's `bg-theme-base/80` and every Library card's `hover:bg-theme-surface-2/50` did nothing. (The header has since gone opaque `bg-theme-base` with no blur, #1649.) All three are now registered beside `theme-surface`, and `src/theme-opacity-modifiers.spec.ts` scans every template and component and fails on a theme/status colour used with `/NN` that `@theme` does not register.
- **E-Ink legibility**: e-paper devices flatten thin strokes and low-contrast grays into the page (icons became indistinguishable). The `eink` theme therefore pushes `--theme-text-secondary`/`--theme-text-muted`/`--theme-border` much darker, sets a `font-weight: 500` floor, and a `[data-theme="eink"] svg { stroke-width: 3 }` rule thickens every stroked icon (unitless so it scales per icon; the app draws icons at `stroke-width="2"`). Guarded by `packages/e2e/tests/theme.spec.ts`.
- Settings UI: Settings → Appearance — swatch grid + "Follow system theme" toggle
- **Settings / Admin / Extensions split**: the core **Settings** page holds only universal user prefs, grouped into 4 cards — each with a uniform icon+title+description header (`SettingsGroupHeaderComponent`, `packages/web/src/app/components/settings-group-header/`) — **Appearance** (theme, language), **Playback & Offline** (autoplay, remote cast, offline storage/auto-preserve), **Account & Devices** (identity, sign-out, links, update check), and **Advanced** (platform-only Server/Desktop/iOS-diagnostics sub-sections, each gated on its own platform flag — the card itself is hidden entirely on plain web, admin or not, since it has no more admin-only content, #754). Server-admin tools (streaming, library processing, find-duplicates) live on **Admin**; extension config (slskd connection/shares + a live status panel) is embedded inline in the slskd extension's own collapsible card under **Extensions** (`/settings/plugins`, relabeled from "Plugins") — no more dedicated per-plugin route. Admins reach both via links in the Settings → Account section. → [docs/admin-settings-decoupling.md](admin-settings-decoupling.md)
- **Settings-cards unification (every settings-family view)**: `/settings`, `/admin`,
  `/settings/plugins` (incl. each `PluginCardComponent`), `/settings/devices`,
  `/settings/agent-tokens` and `/settings/about` all render their groups through the one shared bordered, collapsible
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
  computed styles across every route in its `ROUTES` array — **a new settings route must be added to
  that array _and_ to its `WRAPPER_MAX_WIDTH` map, or the family assertions silently skip it**;
  `tests/settings-gallery.screens.ts` (out-of-CI, run via
  `cd packages/e2e && bunx playwright test --config=playwright.screenshots.config.ts`) captures a
  collapsed + fully-expanded shot of every route in both a mobile and a desktop viewport for human
  side-by-side review. Full component/persistence rationale (superseded `AdminGroupComponent`, the
  `opened` no-double-fire guarantee, the dead `nicotind-admin-group-` prefix) →
  [docs/design-patterns.md](design-patterns.md) "SettingsGroupComponent".
- **Icon buttons (`app-icon`)**: universal actions (Back, Play/Play All, Download, Share, Add, Delete, Close) render as **icon-only** buttons via `components/icon/icon.component.ts` — a small `name`→glyph set (lucide-style, 24 viewBox, `stroke-width="2"`). Centralizing replaced the hand-copied inline SVGs (Back lived in 3 files) and gives the e-ink stroke rule one shape to thicken. **The button — not the icon — owns the accessible name**: every icon-only button carries `aria-label` + `title` (the `<svg>` is `aria-hidden`), and keeps its `data-testid`. Non-universal/ambiguous actions (Select, Optimize metadata, Remove album, admin CRUD, Reset PW) **stay text**. The `SelectionBarComponent` icon actions are targeted in tests/e2e by `data-testid` (`selection-add`/`selection-delete`/`selection-cancel`).
- **Icons & favicon**: PWA icons (`public/icons/icon-{192,512}.png`, maskable, `apple-touch-icon.png`) **and** the browser-tab favicon (`public/favicon.ico` + `public/icons/icon.svg` + `icon-{16,32}.png`, linked from `index.html`) are all generated from **one brand SVG** in `packages/web/scripts/generate-icons.ts` (`bun run generate-icons`) — the same mark the manifest references, so the tab icon matches the installed-app icon. The `.ico` is built via ImageMagick `convert` (sharp can't encode ICO); it's a dev-only regeneration step (outputs are committed). Served-asset guard: `packages/e2e/tests/favicon.spec.ts`.
- Cover art: `packages/web/src/app/components/cover-art/cover-art.component.ts` — themed placeholder **held until image bytes arrive**. The component wraps a `relative overflow-hidden` container; the gradient+initial sits `absolute inset-0` underneath; the `<img>` is `opacity-0` + `transition-opacity duration-300` until its `(load)` event fires (`imgLoaded.set(true)`), at which point it fades in over the gradient. On error (`imgError`), the gradient stays. An `effect` resets both flags whenever `resolvedSrc()` changes so navigating between items re-shows the placeholder — **except under `holdPrevious`**, set by two kinds of cover: those whose `src` swaps in place on a skip (#1653), the player bar (`player-cover-art`) and the Now Playing sheet (`now-playing-cover-art`), and those whose `src` can change by cover rev alone (#1666), the artist hero, the Artists-grid tiles, the related-artists tiles, the find-bar artist tiles, the album hero (album-detail) and the Library album, compilation and single grids, where a replaced portrait or album cover re-keys the URL of an image already on screen. There the last _loaded_ image stays up as a `cover-art-held` `<img>` under the loading one until `COVER_HOLD_FADE_MS` after its `(load)` (`onImgLoad` — the new image fades in _over_ it, so dropping it at load would dip to the background) or at its `(error)` (`onImgError`, which drops it and shows the placeholder), so a skip between two covers never paints the gradient — skipping back to the cover still on screen holds it too. A coverless next track shows the placeholder at once and forgets what it could hold, so the cover after it does not resurrect one from two tracks back; with nothing loaded yet (first paint) there is nothing to hold. A grid tile leaves it off unless its src can change by rev alone — a tile's first paint is placeholder-until-loaded by design, but a rev re-key of a loaded portrait flashing the gradient is not. Both of those covers also load `eager` (they used to default to `lazy`). `showPlaceholder()` is the one predicate the template reads. Covered by `cover-art.component.spec.ts` → "holdPrevious" and `e2e/tests/cover-art-hold.spec.ts` (a deliberately late `/api/cover` route). Pure helpers (`placeholderGradient`/`placeholderInitial`/`placeholderFontSize`) remain exported for unit testing. A `fill` input switches from a fixed px size to `w-full aspect-square`.
- **Cover URLs (#1666)**: build an `/api/cover/<id>` URL through `CoverRevisionsService.url(ref, size, token)` with a `CoverRef` from `artistCover` / `albumCover` / `songCover` (`lib/cover-url.ts`), never by concatenation. The URL carries `v=<rev>` — the DTO's `coverRev` or a newer one pushed by `artwork.changed` or a mutation answer — so it changes when the bytes do; the browser caches `/api/cover` for a day by URL, so a hand-built id-only URL shows a replaced cover a day late, and a page-local counter (the old `imageVersion` / `artistImageVersion`) forgets the change on the next mount. `coverRev` is required on `CoverRef` so a migration cannot drop it silently. A cover whose src can change by rev alone sets `holdPrevious`. The pure `coverUrl(ref, size, token)` spells the URL and leaves `v` off at rev 0; `coverPath(ref)` is the size- and token-less form a server-shaped candidate URL takes. A page on another credential (share, poll) passes its own JWT as the token. Anything keyed off a cover — the lock-screen artwork builder, the Now Playing palette — takes the `CoverRef`, not the bare id. `lib/cover-url.sweep.spec.ts` fails any `.ts`/`.html` line outside the helper that builds an `/api/cover` URL by hand. The overlay, the gap rule, the guards and the migrated sites are in [cache-invalidation.md](cache-invalidation.md) "The web half". Tests assert the component method (`artistImageSrc`, `coverSrc`, `artistCoverSrc`), not the nested `<app-cover-art>` src, because this harness does not bind nested signal inputs.

## Key Angular Patterns

- **Services with signals**: All Zustand stores became `@Injectable` services using `signal()` / `computed()` (no NgRx). 1:1 mapping: `PlayerService`, `TransferService`, `SearchService`, `ThemeService`, `RemotePlaybackService`, `PreserveService`, `AuthService`, `ListControlsService`.
- **Tile interaction standard (#1298)**: every tile and row answers the same three gestures with the same menu. **Hover** fades in a ⋯ (`EntityMenuButtonComponent`, `data-testid="entity-menu-button"`, `opacity-0 group-hover:opacity-100 focus-visible:opacity-100`, so it is in the tab order), **right-click** and a **touch hold** (≈450ms still; a mouse press is never a hold — desktop has hover and right-click) open it at the pointer (`EntityActionsDirective`, `[appEntityActions]="() => TrackAction[]"`, a factory so a grid builds a menu only when one is asked for; the hold eats the release's click through a capture-phase listener so the tile does not also open). There is **one open menu**, `EntityMenuHostComponent`, mounted once in the layout like the confirm host, drawn as a `.glass-panel` (translucent surface at the theme's `--theme-glass-alpha`, `backdrop-filter` blur, `--theme-glass-edge` hairline, `--theme-elevation-overlay` shadow) with a short `.panel-enter` scale-in that `prefers-reduced-motion` skips (#1638): tiles call `EntityMenuService.open({ actions, at | anchor })` and never carry a panel of their own; it is clamped into the viewport above the bottom chrome (`clampMenuPosition` + `measureBottomChromeInset`), closed by Escape, an outside click, hardware Back or running an item, with ArrowUp/Down between items. **One action source per kind**: songs keep `SongMenuService.build()`, albums/artists/genres/playlists get `EntityMenuService.build(ref, ctx)` in a fixed order — Start radio (the app's one verb), Play, Play next, Add to queue, Save offline, Open, then `ctx.extraActions` last (the Library's curator Hide/Unhide album rides there) — every verb fetching the entity's tracks through the same API the detail page uses and handing them to the same `PlayerService` calls, with the detail pages' own preserve keys. A genre radio is a filter radio (`getFilterRadio` → `startRadioWithFilter`), the rest are list radios anchored on their own songs. Wired on: the Library album/compilation/single/artist/genre cards and playlist rows, `album-tile` (owned/partial only), the four classic shelves (song tiles draw the song menu, tastemakers the playlist menu), `track-row` (right-click and hold open its existing ⋯ list), and the mosaic (delegated on the stage: the old hold-for-info is now the hold-for-menu with **Song info** as an item, right-click on a tile, and a `.mosaic-more` ⋯ in each face's HTML — sized with the face via `--face-more`, and `display: none` wherever hover is not real, because on touch the invisible ⋯ still caught taps and a small tile's tap opened its menu instead of playing it (#1642); touch opens the menu by holding). The menu services are resolved through `Injector.get` at open time so a page rendering a hundred tiles never instantiates their dependency graph. Nothing on TV (`isTvUi()`): a D-pad long-press is a different contract and there is no hover. **The hold ticks** `haptic('hold')` at the moment the menu opens — at `HOLD_MS`, never on the release, a tap, a slop-cancelled pan or a mouse press; right-click does not tick (#1659, [mobile-app.md](mobile-app.md) "Haptics"). Covered by `entity-menu.service.spec.ts` (order, verbs, keys, failure toasts), `entity-actions.directive.spec.ts` (fake-timer hold, slop, cancel, click suppression, TV), `entity-menu-host.component.spec.ts`, `entity-menu-button.component.spec.ts`, the wiring specs on library/track-row/album-tile/mosaic, and `entity-menu.spec.ts` (e2e: right-click and hover on the Library, a track row, and the mosaic hold → Song info). The touch hold is a real-device gate, as for the player swipes.
- **Per-user preferences (#1299)**: what follows a person across devices — `homeView`, `theme`, `followSystemTheme`, `language`, `radioStrategy`, `welcomeDismissed`, `queueAcquired` (the get-then-hear opt-out, [get-then-hear.md](get-then-hear.md); `null` reads as on, and a mirror without the key still parses) — is one typed object, `UserPreferences` in `@nicotind/core` (every key nullable on read, `null` = never chosen on the server; a patch never carries null and must choose something). **The zod schemas (`UserPreferencesSchema`/`UserPreferencesPatchSchema`, `user-preferences-schema.ts`) are API-only**: the web validates its mirror and server replies with the hand-written `parseUserPreferences` from the zod-free `user-preferences.ts`, because importing a zod schema into a root service put zod into the initial bundle and blew the 780 kB budget by 57 kB. Server: `user_settings` columns (`home_view`, `follow_system_theme`, `language`, `queue_acquired` added; the legacy `theme` column's NOT NULL `'system'` default reads as null), `services/user-preferences.ts` `getUserPreferences`/`patchUserPreferences` (a merge upsert), `GET`/`PATCH /api/me/preferences` (`routes/user-preferences.ts`, caller-scoped, 400 + `VALIDATION_ERROR` on an unknown key or out-of-range value) and the same object **embedded in `GET /api/auth/me`** so boot needs no second round-trip. The older per-key routes (`/auth/dismiss-welcome`, `/recommendations/preferences`) write the same columns and stay as aliases. **The three dead columns (`autoplay_on_load`, `default_min_bitrate`, `default_file_types`) are left in place**: the schema is additive-only and `config-export.ts` / `privacy.ts` read `user_settings` generically. Web: `UserPreferencesService` is the one door — a **per-device mirror** (`nicotind-prefs`) read synchronously at construction so the first paint after a reload already shows the remembered choice, `hydrate()` from `/me` (server wins), and `patch()` that is optimistic, reverted on a failed write, and **sends nothing without a stored session** (the login/setup/share pages carry a language picker before any user exists, and a 401 there would make the interceptor bounce the user mid-login). `HttpClient` is optional so specs that never provide it still run. The owners keep their own signals and device keys and depend on the door, never the reverse: `ThemeService.setTheme`/`setSystemTheme` and `TranslateService.use()` (a _choice_, not the init-time resolution) write through, `adoptPreferences()` on each takes what the door holds after `refreshSession` hydrates it, and both consult the mirror at construction/init so the last person to sign in on this device wins over the device key. `AuthService.resetSession()` clears the mirror. Covered by `user-preferences.service.spec.ts`, the theme/translate/app.config specs, the API route + service tests, and `theme.spec.ts` (e2e: choose, wipe the device keys, reload, still chosen).
- **`HttpClient` + `authInterceptor`**: All API calls return `Observable<T>`. The interceptor attaches Bearer tokens and handles 401/403 auto-logout, except on a request carrying `KEEP_SESSION_ON_401` (`lib/http-context.ts`), whose caller handles the refusal (a TV profile switch, #1410).
- **Domain API services (no monolith)**: the HTTP surface lives in `services/api/` as one stateless `@Injectable` per API domain — `AuthApiService`, `SearchApiService`, `LibraryApiService`, `DownloadsApiService`, `SystemApiService` (status/settings/admin/setup), `PlaylistsApiService` — sharing one web-local types module `services/api/api-types.ts` (`Album`, `Song`, `CatalogSearchResult`, …; _not_ `@nicotind/core` schemas). **Inject the specific domain service** you need (`inject(LibraryApiService)`), not a catch-all; a component spanning domains injects each one. The former 988-line `ApiService` god object was split out and removed. Each service has a co-located `*.spec.ts` driving it through `HttpTestingController` (URL + verb + body asserts) — the standard for new endpoints.
- **Cached whole-library reads (`lib/cached-observable.ts`)**: `getArtists()` / `getGenres()` are stable lists the library page re-fetches on every visit; each is wrapped in `createCachedObservable(source, ttlMs)`, which `shareReplay`s one request for repeat `get()`s within the TTL (default 30 s) and drops a _failed_ fetch so the next call retries (no error-poisoned cache). `LibraryApiService.invalidateLibraryReads()` clears them; `TransferService.markLibraryDirty()` (the single choke-point behind every `libraryDirty` transition — download/scan/acquire completion + post-delete scan poll) calls it, so a change re-fetches instead of replaying a stale list. Reach for this only on reads needed whole and often; paginated reads (`getAlbums`) stay uncached.
  - **Mutations must `tap(() => invalidateLibraryReads())` (issue #237 audit)**: any `LibraryApiService` write whose server handler mutates `library_artists`/`library_genres` (directly or via a sync rescan) must pipe the invalidation on success, or the Genres tab / Artists grid replays the pre-mutation list until the 30 s TTL lapses (the #210 shape). The full audit of every mutating method + its verdict lives in the same PR body; the ones that invalidate: `setArtistGenre`/`clearArtistGenre` (#210), `fixArtistIdentity`, and (this audit) `applyGenre` (refreshes `library_genres` counts), `applyMetadata` (new-artist insert + orphan prune), `deleteSongs` (runs a resync + can empty an artist/genre), `deleteAlbum` (`pruneOrphanArtist` + empty-genre delete), `resyncLibrary` (full rebuild). Correctly **not** invalidated: artist-image writes (`uploadArtistImage`/`setArtistImageFromAlbum`/`resetArtistImage` — the list's `coverRev` _does_ go stale on these writes, for up to the TTL, but the menu raises the rev the write answers into `CoverRevisionsService` and every grid URL takes max(DTO rev, overlay), so the URL is already right and invalidating would only refetch the list — see "Cover URLs"), cover/lyrics/bpm writes (not in either list), reclassify/hide (album-grid only, uncached), and `optimize*Metadata` (cover/year/release-type, no artist-set or genre-set change).
- **Standalone components**: No NgModules. Every component declares its own `imports` array.
- **`isXxxEmpty` computed pattern for lazy-loaded tabs**: tabs that fetch data on first visit (artists, genres, compilations, singles in `library.component.ts`) pair each `loadingXxx = signal(false)` with an `xxxFetched = signal(false)` flag (set to `true` in the fetch's `finally` block). The empty-state message is gated behind `isXxxEmpty = computed(() => xxxFetched() && !loadingXxx() && items.length === 0)` so it physically cannot appear before the first fetch completes, preventing the "No items found" flash on tab switch or cold load.
- **`effect()` for side effects**: Replaces React's `useEffect`. Used for audio playback coordination, auto-refresh on download completion, remote device sync.
- **Reactivity & event-handling conventions** (one consistent signal-first standard, no leaked subscriptions/listeners):
  - **State-shaped streams → `toSignal()`**: bridge an Observable that represents _current value_ (e.g. the SW version stream in `update.service.ts`) into a read-only signal via `toSignal(...)`, rather than `.subscribe()`-ing into a writable signal.
  - **Subscription teardown → `takeUntilDestroyed(destroyRef)`**: never hand-roll `Subscription[]` arrays or `ngOnDestroy` unsubscribes for lifecycle cleanup. Inject `DestroyRef` and pipe `takeUntilDestroyed(this.destroyRef)` (used in `remote-playback.service.ts`, `settings.component.ts`, `layout.component.ts`). Keep a `Subscription` handle _only_ when you need to cancel imperatively (e.g. restart a poll), not for teardown.
  - **RxJS stays where it's the right tool**: genuine multi-subscriber event streams keep using RxJS — the WebSocket message bus (`playback-ws.service.ts` `Subject`) and router events. Don't force-convert these to signals.
  - **Pointer-drag gestures → `createPointerDrag()`**: all `document` pointermove/one-shot pointerup drag gestures go through the shared `packages/web/src/app/lib/pointer-drag.ts` primitive, which owns the left-button guard, the `dragging` signal, and **automatic listener teardown via `DestroyRef`**. Do not hand-wire `document.addEventListener('pointermove'…)` in components. **It also wires a one-shot `pointercancel`** (a touch pan the browser reclaims mid-gesture fires `pointercancel`, never `pointerup`) — the handler defaults to `onCancel ?? onEnd`, so a caller that only supplies `onEnd` still settles its drag state on cancel instead of stranding it `dragging=true` forever; a caller that needs different cancel behaviour (pull-to-refresh: cancel-while-armed still commits) supplies its own `onCancel`.
- **`viewChild()` signal queries**: Replace React `useRef` for DOM element access (e.g. `<audio>` element).
- **Offline downloads (preserve)**: `PreserveService` + IndexedDB layer (`preserve-store.ts`) cache audio blobs per track and **one cover per album** locally; the player serves preserved tracks from IndexedDB and falls back to `/api/stream/:id`. **Preserved artwork shows offline (#1658)**: the store (DB v4) keeps covers in a `covers` store keyed by `coverKeyOf(meta)` (`album:<id>`, the album that owns the cover's rev, so an album tile and its tracks share one entry). Every preserve writes the album's newest copy. A remove deletes the cover only when no other preserved track points at it, and the v3→v4 migration moves each old per-track cover into it, first per album wins, then clears `blobs.cover`. `PreservedCoversService` turns them into object URLs, rebuilt after every preserve or `refreshList`, revoking the ones it replaces. `CoverRevisionsService.url` hands one out **while the app is offline** — no network, or the server not answering while the device is online (#1751: a dead server serves no covers either) — read from `OfflineModeService.isOffline`. That URL builder sits behind every cover since #1666, so tiles, rows, the player bar, Now Playing and the lock screen need no per-site change, and `ServerConfigService.apiUrl` passes a `blob:` URL through untouched. Online, the network URL still wins, because a preserved copy can be older than the live rev. One 600px copy is scaled down by CSS (owner decision). A preserved row also keeps `artistId`, `artists` (the credits with ids) and `genre`, so artist links and joint credits survive offline. **Preserved lyrics, so karaoke works offline (#1751)**: DB v5 adds a `lyrics` store keyed by track id, holding the song's stored `LyricsDto`. A preserve takes it from `LyricsService.snapshot` (the entry already held, else the server's stored row — never the sources, so saving an album costs no lyrics fetches) and writes it in the same transaction; a remove or Clear all deletes it with the track. `LyricsService` reads the copy (`fromPreserved`) when `NetworkStatusService.online` is false, or when a server read fails while the device is online (server unreachable), and keeps it current from every server answer — a read, a `lyrics.changed` re-read, a Re-fetch, an edit, a delete, a confirmed sync offset — via `refreshLyrics`, which writes only while the track is preserved. `PRESERVE_STORE` lives in `preserve-store.token.ts` so `LyricsService` reads the store without importing `PreserveService`. An offset nudged offline is not stored: the PATCH fails and the view reverts, as online. **Older preserves are topped up once (#1751)**: a row saved before a preserve stored everything has no `toppedUp` marker (`needsTopUp`). `PreserveService.topUpOlderPreserves` runs after `init` and whenever the app leaves offline mode, one run at a time: it resolves the rows in batches of `TOP_UP_BATCH` (`POST /api/library/songs/resolve`), writes the credits, artist id, genre, album id and cover rev through `updateMetas`, and — for the person's own saves only, since auto-preserves churn with the queue — adds the album cover when the device has none for that album (only while under the storage budget, `putCover`) and the stored lyrics (`LyricsService.topUpPreserved`, so lyrics keep their one owner). A song the server no longer has is marked too, so it is not asked for again; a failed lookup ends the run and leaves the rest for the next time. New preserves are written with the marker. Until then the offline Songs tab says how many saved songs have basic details only (`needingDetails`). **Offline mode is one dependency-free signal (#1751)**: `OfflineModeService` holds `serverUnreachable` and `isOffline` (no network, or the server not answering); `SetupService` runs the probe, is the only writer, and its `isOffline` is that signal — so cover URLs and entity links read the mode without pulling `HttpClient` into their consumers. **Links stay live offline (#1751)**: the album and artist pages need the server, so offline an album or artist name (`EntityLinkComponent`, the song menu's Go to artist / Go to album, Now Playing's plain-text artist) opens `/library?find=<name>` (`offlineFind` in `lib/route-utils.ts`), and the offline Songs tab seeds its search from `find` — re-applied whenever the param changes, since a link followed from the Library re-uses the tab. A genre or playlist link, which has no offline view, renders as plain text. Online the same `find` opens the find bar's results. Covered by `preserved-covers.service.spec.ts`, `lyrics.service.spec.ts` ("preserved copies"), `offline-artwork.spec.ts`, `offline-lyrics.spec.ts`, `offline-links.spec.ts` and `offline-topup.spec.ts`; the e2e drives the real IndexedDB: one cover per album, a `blob:` src offline, the cover kept until the album's last track goes, and the v3 migration. Triggered from the UI two ways: a **per-track "Save offline" / "Remove download"** action (built by `offlineTrackAction()` in `lib/track-utils.ts`, wired into the track-row menu on album/playlist/genre detail pages, with the row's green `offline` dot) and **collection-level Download buttons** on those same pages. `preserveCollection(key, name, tracks)` is **keyed by a stable collection id** (album/playlist id, genre slug) into a `batches` map signal — so different collections download **in parallel** and each page shows only its own progress via `batchFor(key)` (a single global batch previously made every collection's button read "Saving…" and blocked starting a second download). Budget is enforced against the live `totalUsage` signal so concurrent batches share one running total and can't collectively overshoot the cap. **Single-track `preserve()` evicts LRU to make room, but the bulk path stops at the cap instead** (`stoppedAtCap`) so a huge collection keeps what fit rather than thrashing the same batch (the genre page fetches the full genre — `getSongsByGenre(slug, 5000)`, API cap raised to 10000 — so "Download" can preserve the whole list up to the cap). The storage **budget is user-configurable** in Settings → Offline storage (1/2/5/10 GB or Unlimited), persisted to `localStorage` (`nicotind-preserve-budget`) and surfaced with a usage bar; the **Library → Songs tab (offline variant)** manages preserved tracks (usage bar + Clear all + list) — see the Library Songs bullet below. (The Downloads page's former "Saved Offline" tab was removed when the offline browse surface moved into Library.)
- **Offline / network detection (reactive)**: `NetworkStatusService` (`services/network-status.service.ts`) exposes a single live `online` signal — from `@capacitor/network` on the native shell (via `getCapacitorPlugin('Network')`, no web-bundle import; Android WebView `navigator.onLine` is unreliable) and from `navigator.onLine` + window `online`/`offline` events on web/Electron. `SetupService.isOffline` is a **`computed`** (`!network.online() || serverUnreachable`), so the four offline consumers — the library source swap + `visibleModes()`, nav gating (`ONLINE_ONLY_ROUTES`), the `app.ts` redirect, and the new banner — all react to connectivity flips **in both directions** with no reload (previously offline was a one-shot boot inference). `SetupService.check()` **skips the boot HTTP probe entirely when already offline**, removing the multi-second blank-screen boot behind the Android offline-launch ANR. **The native seed is async, so `check()` first awaits `NetworkStatusService.whenReady()`** (bounded by `NETWORK_SEED_TIMEOUT_MS` = 1.5 s) — without that await, `online()` was still its optimistic default `true` when the initializer ran, the fast path was silently skipped, and the offline-launch ANR persisted despite it. **The offline switch is now fully automatic in both directions**: the `authInterceptor` reports any status-0 (network-level) failure on an `/api`/`/rest` path via `SetupService.reportServerFailure()`, which fires a **verification probe** before flipping the flag (one flaky request must not bounce the app offline; single-flight; no-op while already unreachable — the recovery poll owns retries); once unreachable, `SERVER_RECOVERY_POLL_MS` (20 s) re-probes until the server answers (zero background traffic when healthy), and a **device reconnect fast path** (a `SetupService` constructor `effect` on the offline→online transition) re-probes immediately so leaving airplane mode recovers in one round-trip — it also fires when `status` is still `null` (an offline _launch_ skipped the boot probe, so the app must learn `needsSetup`/server state now), while a healthy already-probed session reconnecting after a blip adds no probe. `verify()` is the **single writer** of `serverUnreachable` in both directions — boot, interceptor report, recovery poll and reconnect all converge there. The boot session refresh (the exported `refreshSession` in `app.config.ts`) now runs **after** `check()` and only when online, so an offline launch keeps the stored session (offline library stays usable) instead of churning on doomed auth calls; on the first return to online a one-shot self-destroying `effect` runs the deferred refresh (roles/flags re-sync without a reload) with `withAutoplay: false` — a playback resume firing minutes after launch when connectivity returns would be a surprise, not a restore. The app-shell **offline banner** (inline in `layout.component.html`, `@if (setup.isOffline())`, now carrying `data-testid="offline-banner"`) renders while offline and auto-hides on reconnect — reactive now that `isOffline()` tracks live connectivity. Mid-use hardening: the player skips a doomed network stream for a non-preserved track when offline and toasts instead of showing an infinite spinner (`player.component.ts` `stopForOffline`); `preserveCollection` swallows per-track offline fetch rejections (no unhandled reject / batch abort); GET requests carry a 30 s `authInterceptor` timeout so a read can't hang in the WebView. **Background traffic stands down offline**: auto-preserve asks for nothing (`AutoPreserveCoordinator`), the `/api/library/events` stream closes and reopens from its last seq on reconnect (`LibraryEventsService`), and the presence heartbeat stops and reports at once on reconnect (`PresenceService`) — each one, retrying into a dead network, kept a phone's radio and CPU awake. Native Sentry drops Session Replay + tracing (the release-only ANR suspect) — see [docs/mobile-app.md](mobile-app.md) §Network / offline detection and [docs/observability.md](observability.md).
- **Disk availability pill (Downloads header)**: `app-disk-pill` (`components/disk-pill/`) shows `used / total` (e.g. "95 GB / 969 GB") with a progress fill that runs **green → red** as the disk fills. Data comes from `GET /api/system/disk` (`SystemApiService.getDiskUsage()`), which `statfs`-es the **music-dir** filesystem (where downloads land) server-side and returns `{ total, free, used }` bytes; the `expandedMusicDir` and an injectable `statfs` are threaded into `systemRoutes(...)`. All formatting/colour maths live in the pure, unit-tested `lib/disk-usage.ts` (`formatBytes`, `usedRatio`, `diskFillColor` — hue-interpolated `hsl()`). The `DownloadsComponent` loads it best-effort on construction and simply hides the pill if the read fails. `data-testid="disk-pill"`.
- **Artist page reacts to `:id` changes**: `ArtistDetailComponent` subscribes to `route.paramMap` (via `takeUntilDestroyed`) instead of reading a one-shot `route.snapshot` in `ngOnInit`, so navigating **artist → artist** while the component is already mounted (e.g. clicking an artist name in the expanded player) reloads the new artist instead of showing the previous one (Angular reuses the instance across the same route config, so `ngOnInit` alone never re-runs). `loadArtist(id)` resets all per-artist state (artist/albums/singles/appears-on/discography/Songs-tab list + observer) before fetching, and guards every async setter against a stale response after a rapid re-navigation. The expanded-player artist links collapse the sheet via the `ArtistLinksComponent` `(linkFollowed)` output, which the cover art re-emits as `artistLinkFollowed` → `closeForNavigation()`: **a host of `app-artist-links` only closes itself and never navigates in that handler**, because each name's `routerLink` already navigates to _that_ artist. Wiring it to `navigateToArtist()` (which routes to the primary artist) made the later navigation win, so every credit after the first opened the first artist (#1655); `navigateToArtist()` now serves only the plain-text artist of a track with no `artists` credits. Regression-tested in `artist-detail.component.spec.ts` → "reacts to :id changes", `now-playing*.spec.ts` → "#1655", and `e2e/tests/now-playing-artist-links.spec.ts` (clicks each credit of a three-artist track).
- **Artist page tabs never collapse; identity fix is immediate**: the artist-detail tab bar (`Albums | Singles & EPs | Appears On | Songs`) renders unconditionally from `visibleTabs()` (only non-empty release tabs + the always-present Songs), and each `@case` carries its own `@empty` slate ("Nothing here yet."). This fixes a bug where an artist with **no own releases but compilation appearances** would, on clicking "Appears On", trip an outer empty-guard (`albums==0 && singles==0 && activeTab!=='songs'`) that swallowed the whole tab bar — leaving a dead "No releases found" screen with no way back. Regression-tested in `artist-detail.component.spec.ts` → "Appears On tab never collapses the tab bar". The **"Fix artist identity"** modal (`ArtistIdentityModalComponent`) gained a 4th radio option, **"Rename this artist"** (free-text prefilled with the current name; posts `{rawName, rename}`), for accent/typo/name corrections that don't merge into another artist — see [docs/library-scanner.md](library-scanner.md). Because the API now runs the rescan synchronously (200, not a fire-and-forget 202), the modal's spinner covers the whole apply and, on success, the artist page routes to the artists grid (`/library?type=artists`) where the split members / corrected name are immediately visible.
- **Auto-preserve queue (PWA lock-screen resilience)**: an opt-in, per-device localStorage toggle in Settings → Offline storage that keeps the next-N queued tracks in IndexedDB so playback survives the browser's locked-screen network throttle (Android Chrome WebView, iOS Web). Off by default — the toggle is "Off / This track / Next 5 / Next 20 / Whole queue" with a one-line explainer. **"This track"** is the data-saver rung: `windowSize` returns 1, so the coordinator's `[current, ...queue].slice(0, 1)` is exactly the track playing and nothing ahead of it is ever fetched. Before it, the smallest way to have offline playback at all was five tracks ahead, which on a metered connection is four tracks nobody asked for. The `AutoPreserveCoordinator` (`services/auto-preserve-coordinator.ts`) wires `PlayerService.currentTrack + queue` into `PreserveService.ensureAutoPreservedFor(target)`, dedupes against `preservedIds + preserving`, and caps concurrency at 3 — **in total**: every call feeds one shared queue drained by at most `AUTO_PRESERVE_CONCURRENCY` workers, and the latest window replaces whatever was still waiting (a skip-ahead stops fetching tracks that left it; turning the mode Off drops the waiting ones too). Per-call workers used to multiply the cap by the number of queue mutations. **The coordinator calls the service `untracked`, and asks for nothing while `SetupService.isOffline()`.** The service's synchronous prefix reads `preserving` and then writes it, so a tracked call subscribed the effect to its own writes: each failed fetch cleared `preserving`, re-ran the effect and fetched the same track again. Offline a fetch rejects in milliseconds, so this was a tight loop — hundreds of attempts a second for a three-track window, pinning the CPU and the radio, which iOS PWA users reported as the phone getting very hot offline. The offline gate is tracked, so reconnecting re-runs the effect and resumes, and the reconnect calls `forgetAutoPreserveFailures`. **A failed fetch is left alone for `AUTO_PRESERVE_RETRY_MS` (60 s)** — offline, a 404, or a body that fails the truncation gate all count — so a track that cannot be saved is not re-fetched on every queue mutation; the coordinator is the defence, the backoff the backstop for the window before the app notices it is offline. `PreserveService.autoPreserve(track)` is the same fetch+store path as `preserve()` but tags the row `source: 'auto'` so `evictAutoLRU` (in the store) prefers auto-source LRU over user-saved tracks — radio churn can't evict the user's intentional offline collection. `PreservedTrackMeta.source: 'user' | 'auto'` (DB v3, one-shot cursor migration backfills `'user'` on existing rows). 'Whole queue' is hard-capped at 200 tracks so a runaway radio can't fill tens of GB. **Changing the mode changes the mode, and nothing else** (#1263). Turning it Off used to prompt to delete every auto-saved track, and _declining the prompt aborted the toggle_ — so "stop downloading but keep what I have" was not expressible, and the only way to stop the downloads was to lose the offline library they had produced. Deleting is now its own button (`clearAutoSaved`, `data-testid="auto-preserve-clear"`, shown only while `autoPreservedCount() > 0`), which still prompts via `ConfirmService.ask(message)` with the count baked in (`"Remove N auto-saved tracks from offline storage?"`) and calls `removeAllAutoPreserved()` only on confirm. Stopping the downloads and discarding what they produced are different intentions, and only one of them is reversible. Tracks left behind this way stay `source: 'auto'`, so they remain the first thing `evictLRU` reclaims when a later user save needs room — kept, but still the lowest-priority bytes on the device.

**One track at a time** is the manual lane, unchanged in mechanism and now translated: `offlineTrackAction` (`lib/track-utils.ts`) sits in every track menu including Now Playing's `⋯`, and carries `labelKey` (`song.saveOffline` / `song.removeDownload` / `song.savingOffline`) alongside the English `label` that remains the `@for` key and the `data-testid` suffix. Auto-preserved tracks show up in the offline Library Songs tab like any other preserve (mixed in — the `source` field is internal). The coordinator ships in **every environment** (dev / prod / native shells); it's effectively a no-op when `autoPreserveMode === 'off'` (the default), so the dev/native gate that the service worker uses (to avoid stale-cache issues) doesn't apply. Settings live in localStorage so a phone user can enable it without affecting a shared desktop.

## Component Conventions

- **Player expand/collapse gesture**: one vertical-swipe primitive, `createVerticalSwipe()`
  (`packages/web/src/app/lib/vertical-swipe.ts`, composed on `createPointerDrag()`), serves the
  mini bar and the Now Playing sheet. It arms a non-passive `touchmove` blocker at pointerdown and
  asks the call site's `resolve(ctx)` exactly once — from whichever of the blocker or the pointermove
  stream crosses `SWIPE_SLOP_PX` first — so the blocker can never prevent a move the handler would
  release. That is the pull-to-refresh lesson (#731) applied to the player: the mini-bar body was
  bound to the open gesture but carried `touch-pan-y`, so the browser reclaimed the pan after ~10px
  and only the `touch-none` grab notch (`data-testid="player-grab"`) ever opened the sheet. The body
  is `touch-none` now and the swipe is **live-follow**: the closed sheet rides
  `PlayerService.nowPlayingLiftPx` up with the finger (`translateY(calc(100% - lift))`) and commits
  on end **or cancel** via `shouldCommit()` — distance past `OPEN_THRESHOLD_PX` (96, up from the old
  40px commit-on-move, because a sheet that visibly follows makes 40px read as accidental) _or_ a
  flick ≥ `FLICK_PX_PER_MS` measured by `flickVelocity()` over the trailing 100ms. A tap still opens.
  The sheet (`now-playing.component`) has **one body gesture** on its root (`onBodyPointerDown`;
  `button`/`a`/form controls/`[data-seek]`/`.seek-range`/the waveform/`app-menu-panel`/
  `[data-np-no-swipe]` are excluded, and nothing starts under karaoke fullscreen). Its mode is
  decided at resolve time from the origin zone (`data-np-zone="panel"` on the tabs+panel wrapper,
  everything else is the stage) and the current state:

  | origin | direction | condition                                                       | mode                                 |
  | ------ | --------- | --------------------------------------------------------------- | ------------------------------------ |
  | any    | up        | below `lg` and the panel has room to grow                       | **resize** (grow the panel)          |
  | any    | up        | otherwise                                                       | release (native scroll)              |
  | panel  | down      | the nested scroller's `scrollTop > 0` (`scrollableAncestorTop`) | release                              |
  | panel  | down      | at the top, panel grown                                         | **resize** (collapse)                |
  | panel  | down      | at the top, panel at rest                                       | **dismiss**                          |
  | stage  | down      | panel grown, below `lg`                                         | **resize** (collapse), then continue |
  | stage  | down      | otherwise                                                       | **dismiss**                          |

  **Continuation**: a collapse that runs out of panel flips to `dismiss` mid-gesture (offset
  measured from the point the panel hit 0), so one uninterrupted pull shrinks the panel and then
  drags the sheet down. Dismiss follows the finger (`dragOffsetPx` → `[style.transform]`,
  `transition-none` while dragging or lifting) and commits past `DISMISS_THRESHOLD_PX` (120) or on a
  flick. The header pill and the resize notch are visible affordances only — their pointerdown
  bubbles to the root. Player text uses `translate="no"` + `.no-callout` to suppress the mobile
  translate/selection popup. Artist/album navigation lives only in Now Playing — the mini bar never
  navigates. **Deliberate e2e gap**, as for pull-to-refresh: CI's Playwright is Desktop Chrome, so
  `mobile-ux.spec.ts` drives the mouse path and the wiring; the touch blocker is unit-tested
  (`vertical-swipe.spec.ts`) and a real-device pass is the manual gate.

- **Queue row gestures (#1295)**: HTML5 `draggable` never starts from a finger, so the Now Playing
  queue was read-only on the phone. `createRowGesture()` (`lib/row-gesture.ts`, composed on
  `createPointerDrag()`, reusing `flickVelocity`/`SWIPE_SLOP_PX`) gives each row two gestures:
  - **Swipe left removes.** The row follows the finger over a red reveal
    (`data-testid="queue-swipe-reveal"`) and commits through `shouldCommit()` past
    `QUEUE_SWIPE_REMOVE_PX` (96) or on a flick; a rightward drag never moves it. The removal is
    `PlayerService.removeFromQueue`, and the toast offers **Undo** for `QUEUE_UNDO_SECONDS` (5),
    which calls `PlayerService.insertInQueue(index, track)` (clamped) to put it back where it was.
    A mouse can swipe too (it is the e2e path).
  - **Long-press (`LONG_PRESS_MS`, 300) then drag reorders.** The row lifts (scale + shadow),
    siblings part around it, `reorderTargetIndex` picks the landing index under `moveInList`'s
    remove-then-insert semantics, and the list auto-scrolls in a 48px band at either edge.
  - **Ownership** is the #731 lesson turned around for a scroll list: the row is `touch-pan-y`, so
    a horizontal move is never a browser pan and needs no blocker; a vertical move is the list's
    scroll _unless_ the long-press has fired, so the non-passive `touchmove` blocker is armed only
    at the long-press. A vertical move past slop before it cancels the timer and hands the finger
    back. The rows carry `data-np-no-swipe`, so the sheet's body gesture never starts on one.
  - **One reorder path**: the touch lift, the HTML5 drop and the handle's keys all call
    `reorder(from, to)` → `PlayerService.moveInQueue`; remove and undo are the same PlayerService
    mutations, so nothing new reaches remote playback. The ⋮⋮ handle (`data-testid="queue-handle"`,
    44px, `role="button"`) is the long-press hint, the mouse's only HTML5 drag source (a native
    link/image drag from the row body is prevented, or it would cancel a mouse swipe), and moves
    the row one step on ArrowUp/ArrowDown with focus following it. It is a `div`, not a `button`:
    Firefox never starts an HTML5 drag from a `<button>`. `draggable` is set only on a fine pointer
    so an Android long-press cannot start a native drag under ours.
  - A gesture swallows the click its release may synthesize (capture-phase, one tick) so a swipe
    ending on the title never also jumps; a long-press's `contextmenu` is prevented.
    TV keeps `now-playing-tv-queue`. Unit: `row-gesture.spec.ts` (blocker armed at the long-press,
    released on a plain pan, slop, swipe velocity, cancel) and the queue panel spec (threshold and
    flick commit, undo index, keyboard reorder, shared drop path). e2e: `queue-gestures.spec.ts`
    (handle drag-reorder and a `page.mouse` swipe-remove + Undo). **The touch path is a real-device
    gate**, as for the player swipes.
- **Swipe to skip** (#1297): a horizontal swipe on the **full Now Playing sheet** skips —
  **← next, → previous** — through the same `handleNext`/`handlePrev` as its ⏭/⏮ buttons, so a remote
  device gets the same `NEXT`/`PREV` command. **The minimized mini bar does not skip**: it only opens the
  sheet (tap / swipe up). The swipe may start anywhere on the sheet except the scrolling panel
  (`[data-np-zone="panel"]`) and `SKIP_SWIPE_EXCLUDE`, not just on the 60vw artwork — a swipe that began
  beside the cover used to do nothing. The sheet root is `touch-pan-y` as a defensive measure: the
  touchmove blocker alone already passes real CDP touch events in Chromium (`mobile-ux.spec.ts` "touch
  swipe"), so this is not shown to be required there, but it keeps a WebView from claiming a sideways
  pan; the queue's vertical scroll is unaffected. It is
  `createHorizontalSwipe()`, the sideways sibling in `lib/vertical-swipe.ts`: both are one
  `createAxisSwipe` core with the same slop, touchmove blocker and flick measurement, and the
  commit is `skipDirection()` (`lib/swipe-to-skip.ts`: `shouldCommit` against
  `SKIP_THRESHOLD_PX` = 80 or a flick). **Both axes start from the same pointerdown** (the sheet's
  `onBodyPointerDown`), so two rules keep them from both firing:
  every swipe classifies an event with the same `dominantAxis()` (a blocker tie goes to the vertical
  swipe, a pointermove tie to the horizontal one, as `createVerticalSwipe` always did), and the first
  to own the pointer takes a **claim** keyed by that pointerdown, which makes its sibling release
  instead of resolving — the two channels can decide on different events (a vertical first
  touchmove, then a sideways drift before pointermove crosses slop), and the claim is what covers
  that. A skip never starts from `SKIP_SWIPE_EXCLUDE` (buttons, links, form controls, the seek bar,
  the waveform, menus; a neighbour sliver is the one button excepted, below); the grab notch starts
  only the vertical swipe. While dragging, the cover
  follows the finger (`swipeOffsetPx`) and the neighbour carousel (below) moves with it.
  A commit calls `haptic('commit')` (`lib/haptics.ts`, the #1659 vocabulary; `hapticTick()` is its
  alias) — once per skip, never also the transport button's `tap`. The sheet's open and dismiss
  snaps and the queue's swipe-remove commit the same way; see [mobile-app.md](mobile-app.md)
  "Haptics" for the table, the Off/Reduced/Full setting and where it is a no-op. TV has no pointer, so nothing changes there. e2e (`mobile-ux.spec.ts`) drives the mouse path on the sheet (cover and background) and asserts the mini bar does not skip; the touch arbitration is
  unit-tested (`vertical-swipe.spec.ts`), and a real-device pass is the manual gate.
- **Neighbour carousel** (#1652): the Now Playing sheet shows, **at rest**, the cover ⏮ would land
  on peeking in from the left and the one ⏭ would land on from the right, dimmed (`opacity` 0.5)
  and scaled to 0.85 toward the current cover; the one a swipe heads for comes up to full size.
  Which track each side is comes from `PlayerService.nextNeighbour` / `prevNeighbour`, two computeds
  kept beside `playNext`/`playPrev` and pinned against them in `player.service.spec.ts`: next is the
  queue head (already shuffled, under shuffle); **none** under repeat-one (the skip replays), on a
  drained queue that pauses (radio included, until its top-up lands), or under repeat-all + shuffle
  on a drained queue (the context is reshuffled at the moment of the skip); repeat-all without
  shuffle on a drained queue is the context's first track. Previous is the history tail, none on an
  empty history. No neighbour means no element, so there is never a dead tap target. The neighbours
  are absolutely placed 1rem beside the cover inside a stage (`now-playing-cover-stage`). **On a
  phone (below md) they bleed to the screen edge** (#1763): the stage's clip is `inset(0 -100vw)`,
  so the cover column's `overflow-hidden` is the real edge and a neighbour reads as a card sliding
  in from off-screen rather than one cut short mid-screen. That column is `overflow-clip`, not
  `overflow-hidden` (#1749): a hidden box is still a scroll container, so anything that scrolled a
  neighbour into view — a screen reader landing on its label, Playwright retrying an obscured
  hover — slid the cover off centre with the previous sliver off-screen. From md the clip is
  `inset(0 calc(-1rem - 12%))`, 12% of the cover width of each, so a wide sheet shows a sliver, not
  two whole covers. Either way the clip also clips hit testing, so only the visible part is
  tappable. **They fade out as the queue resize shrinks the cover** (#1763): `neighbourFade`
  multiplies their opacity from 1 at the cover's rest width (`min(60vw, 20rem)`) down to 0 at half
  of it, and a faded-out neighbour is `pointer-events-none`; the transition is off while the resize
  drags so they track the finger. At lg the cover ignores the shrink, and so does the fade. A tap (`now-playing-cover-next` /
  `now-playing-cover-prev`, `<button>`s labelled with the target title) emits `skipRequested`,
  which the sheet routes through the same `handleNext`/`handlePrev` as ⏭/⏮. They are buttons for
  that tap, but a drag from one is a drag of the cover: `data-np-sliver` makes `gestureOrigin`
  (`lib/swipe-to-skip.ts`) judge the press from the strip it sits on, so neither `BODY_NO_SWIPE` nor
  `SKIP_SWIPE_EXCLUDE` swallows it — sideways skips, down dismisses, as beside any other part of the
  cover. The click the browser still fires on the sliver when that drag lifts is dropped
  (`onSliverSkip` ignores one within 500 ms of an owned gesture's end; the next pointerdown clears
  it), or one pull would skip twice, or skip and close. **While this device controls another**
  (`drivesLocalPlayer()` false) there are no slivers: the output's history, repeat and shuffle are
  not mirrored here (a `show-track` never touches history), so a labelled neighbour would promise a
  track ⏮/⏭ on the output may not land on; the swipe still sends NEXT/PREV. Out of the tab order
  (`tabindex="-1"`; ⏮/⏭ are the keyboard path) and absent on TV (`isTv`, the pinned D-pad order).
  At `lg` the outer `overflow-hidden` wrapper is the cover column, so where the side panel narrows
  it, the sliver is clipped to the column and never reaches over the panel. They load `eager` at
  the sheet's 600px size, so the cover a skip lands on is usually already decoded — the other half
  of #1653's `holdPrevious` on the current cover. e2e: `mobile-ux.spec.ts` "neighbour carousel"
  and `now-playing-desktop.spec.ts` (the narrowed lg column); story `NowPlaying/NeighbourCovers`.
- **Pull to refresh (touch)**: one gesture, hosted in the layout shell, not per-page. `lib/pull-to-refresh.ts` `createPullToRefresh()` composes `createPointerDrag()` and is bound once in `layout.component.ts` on `<main>`'s `(pointerdown)`, rendering a spinner indicator absolutely positioned inside it; `PullToRefreshService` is the seam a page uses to say what "refresh" means — `register(handler)` pushes onto a handler stack, auto-unregistered on the registrant's `DestroyRef` (route navigation destroys the page component, so this is route-scoped for free), and `trigger()` runs the top-of-stack handler. This is layout-hosted rather than per-page because the scroll container is `window`/`document` (the app has no per-page scrolling `<div>`), so "pulled past the top" is a single global condition (`window.scrollY <= 0`) regardless of which route is mounted — one gesture host, many registrants.
  - **Gates before a pull can start** (`onPointerDown`, all must hold): `isCoarsePointer()` (a real `matchMedia('(pointer: coarse)')` check — desktop mouse/trackpad never engages it), `window.scrollY <= 0` (only from the very top), `!ScrollLockService.locked` (a fullscreen sheet is up), `PullToRefreshService.hasHandler()` (no page registered = nothing to refresh), and no `[data-no-p2r]`/`input`/`textarea`/`select` ancestor (an explicit per-element opt-out for a nested scroller or a form control that needs its own vertical drag).
  - **Why a non-passive `touchmove` `preventDefault()` is required — and why it is armed at pointerdown, not at intent**: `drag.start()` attaches `document.addEventListener('touchmove', blockTouchMove, { passive: false })` immediately, and the blocker decides per event: pull intent → prevent; scroll intent → never; undecided → prevent only a downward-dominant move (`dy > 0 && dy >= |dx|` — the same dominance rule as the intent test, so horizontal tab-strip pans stay native). The timing is the load-bearing part: the browser reclaims an unprevented vertical pan as its own scroll after ~10px, stops delivering `pointermove` (firing `pointercancel` instead), and marks every subsequent `touchmove` non-cancelable — so preventing the **first** `touchmove` is the only winnable round (per the Touch Events spec it suppresses scrolling for the whole interaction). The original implementation attached the blocker only after intent classification, i.e. after ~10px — guaranteeing it lost that race, which left the gesture completely dead on real touch devices (#731). `overscroll-behavior` does **not** fix this: it only suppresses the _visual/navigation_ side-effect (Chrome Android's reload glow, iOS's bounce-triggered nav), it does not keep the event stream alive. This is also why **a `pointercancel` while `phase === 'armed'` still commits the refresh** (`finish()` routes cancel through the same commit path as a clean pointerup) — on touch you cannot rely on ever seeing a real `pointerup` once the pull has crossed threshold, the same lesson `pointer-drag.ts`'s cancel handling and the player swipe-up gesture (`onMove`-committing, not `pointerup`-committing) already encode.
  - **`@media (pointer: coarse) { html { overscroll-behavior-y: contain } }`** (`styles.css`) suppresses Chrome Android's native pull-to-refresh (a full page reload) so the in-app gesture owns it exclusively. `contain`, not `none` — `none` would also kill iOS Safari/WKWebView's rubber-band bounce, which is expected native feel and orthogonal to the reload behaviour being suppressed; `contain` only blocks scroll-chaining/navigation-triggering, not the bounce itself. Scoped to coarse pointers so desktop two/three-finger swipe-back navigation is untouched.
  - **Indicator is spinner-only** (no pull/refreshing copy) — deliberately zero i18n surface. `phase` (`idle`/`pulling`/`armed`/`refreshing`) and `pullPx` (damped via `dampPull`, an exponential-decay curve capped at `PULL_MAX_PX`) drive only opacity/rotation/spin, nothing textual.
  - **Constants** (`lib/pull-to-refresh.ts`): `PULL_SLOP_PX` = 10 (dead zone before intent is classified pull-vs-scroll), `PULL_THRESHOLD_PX` = 70 (arms the refresh), `PULL_MAX_PX` = 120 (damping ceiling — `dampPull` is `PULL_MAX_PX * (1 - e^(-rawPx/PULL_MAX_PX))`, so indicator travel diminishes the further past threshold the finger goes). `PullToRefreshService`: `REFRESH_TIMEOUT_MS` = 15s (a hung handler is abandoned, never wedges the spinner forever) and `MIN_REFRESH_VISIBLE_MS` = 400ms (a handler that resolves instantly still shows a perceivable spin rather than a flash).
  - **Deliberate e2e gap**: CI's Playwright runs Desktop Chrome only, and `page.touchscreen` cannot emulate a real touch pan (no `pointerType: touch` events, no `(pointer: coarse)` media match) — there is no cheap way to drive this gesture end-to-end in CI. Coverage is unit (`pull-to-refresh.spec.ts`, `pointer-drag.spec.ts`, `pull-to-refresh.service.spec.ts`) + layout-integration specs (`layout.component.spec.ts` asserts the indicator renders/positions off `phase`/`pullPx` and that `onPointerDown` is wired) exercising the pure logic and DOM wiring directly, without a real touch input. A manual pass on a real Android/iOS device is the one thing that still needs a human before merge.
- **Safe-area header (iOS notch)**: the sticky top header (`layout.component`) folds `env(safe-area-inset-top)` into its top padding — `pt-[calc(0.75rem+env(safe-area-inset-top))]` (= the old `py-3` top) — and `index.html` declares `viewport-fit=cover` so that inset is non-zero on notched iOS. Without it the header (and content) sat _under_ the iPhone status bar/notch on the Capacitor iOS build. It's a no-op on web/desktop (inset resolves to 0 → 12px, asserted in `mobile-ux.spec.ts` on a page that shows the header below `md`); mirrors how the bottom player/nav already use `env(safe-area-inset-bottom)`. iOS on-device positioning is a documented manual gate (see [ios-app.md](ios-app.md)).
- **Full-screen sheets clear the notch too**: the Now Playing sheet (`now-playing.component`) and its fullscreen lyrics overlay are `fixed inset-0` over the same `viewport-fit=cover` page, so their **top-anchored interactive chrome** — the drag-to-dismiss grab pill + close chevron (header), and the fullscreen exit button — would sit _under_ the iPhone hardware notch on a PWA / Capacitor build, making the sheet impossible to close (regression: iPhone 13 Pro home-screen PWA, "can't find the player notch to close it"). Both headers pad their top with `pt-[calc(…+env(safe-area-inset-top))]` so the affordances drop below the cutout. No-op on web/desktop (inset → 0). Regression-asserted in `now-playing.component.spec.ts` → "notch / safe-area clearance".
- **Download row overflow contained**: each `download-item` row is `overflow-hidden` (plus `min-w-0` on its wrapping metadata row and `max-w-full` on the expandable storage path), so a long title or file path **stays inside the row's rounded box** (titles `truncate`, the storage path `break-all` wraps) instead of widening the page. On mobile a row that overflowed forced the WebView to zoom out (shrinking all icons/text); `mobile-ux.spec.ts` guards the downloads page against horizontal overflow at phone width.
- **Zoom disabled app-wide** (`styles.css` → `html { touch-action: pan-x pan-y }`, plus `maximum-scale=1, user-scalable=no` in the `index.html` viewport meta): stray double taps and pinches kept zooming the viewport on touch builds (web + native WebView), and iOS zoomed in on focusing any field under 16px (most fields are `text-sm`/`text-xs`) and stayed zoomed after blur. The app has no content that needs zoom, so both gestures are off rather than just double-tap (the earlier `manipulation`). `pan-x pan-y` keeps scrolling; the viewport meta stops pinch in the iOS WKWebView and focus-zoom in iOS Safari too (Safari itself still allows pinch; Apple ignores `user-scalable=no` there). The root rule is an element selector, so the finer-grained gesture surfaces win by specificity: the seek range (`.seek-range { touch-action: none }`) and the player drag handles (Tailwind `touch-pan-y`/`touch-none` utilities). Asserted in `mobile-ux.spec.ts` ("zoom is disabled via root touch-action and the viewport meta").
- **Mini-player layout (two columns on mobile)**: the bar is a 3-section flex row (track info · controls · device switcher). On **mobile** only the track-info column grows (`flex-1`); the controls are content-sized (`flex-none`) and the device-switcher section is content-sized too — so track info fills the bar and pushes the controls to the **right edge** (a clean two-column layout: info | controls). Previously _both_ side sections were `flex-1` to keep controls screen-centered, but the right (device-switcher) section is empty unless remote playback is on, so it reserved a wasted half-width "empty third column" and the controls sat marooned in the center (the reported "controls too centered, right part lost" bug). On **desktop** the side sections collapse (`md:flex-none`, track info pinned to `md:w-72`, widened from `md:w-60` for the larger type of #1743) and the controls reclaim `md:flex-1` to host the inline progress bar. The invariant (track-info is the only mobile `flex-1`; the device-switcher section is never `flex-1`) is asserted in `player.component.spec.ts` → "mini-player layout". `BottomNavComponent` (`components/bottom-nav/`) is a `md:hidden` fixed bar (Home · Library · Downloads · **Search** · Settings; Admin is desktop-only). The Search tab (`/search`, online-only — the route needs the backend) restores the mobile path to the network-browse + URL-acquire page that the radio landing used to link to. The bar is `grid-cols-5`, safe-area-aware: `h-[calc(3.5rem+env(safe-area-inset-bottom))]` + matching bottom padding so the tabs sit above the iOS home indicator. The mini-player floats above it, and the full-screen Now Playing sheet (higher z-index) covers it. **Active tab** uses the theme accent (`--theme-accent`) for both icon+label and a 2 px accent bar painted via a `::before` pseudo-element (`a.is-active` rule in `bottom-nav.component.css`); matches the Downloads badge accent vocabulary and reads cleanly across all 7 themes (E-Ink's black accent keeps it legible). The Downloads tab shows a live badge from the shared `TransferService.activeDownloadCount` computed (also feeding the header `download-indicator`, which additionally sums in-flight `AcquireService` jobs).
- **Bottom chrome layering contract** (`lib/player-chrome.ts`): the mini-player (z-50) anchors one tab-bar height above the viewport bottom on mobile, so its _hidden_ state must translate past its own height **plus** the tab bar and be `pointer-events-none` — a plain `translate-y-full` parked the opaque bar exactly on top of the z-40 tab bar whenever no track was loaded, hiding the nav and swallowing its taps until playback started ("lost bottom menu" bug). `miniPlayerSlideClass()`, `MAIN_BOTTOM_PAD_CLASS` and `TOAST_STACK_BOTTOM_CLASS` (consumed by `PlayerComponent.slideClass` / `LayoutComponent.mainPadClass` / `ToastOutletComponent.stackBottomClass`) centralize this geometry as literal Tailwind class strings (arbitrary values must stay literal for Tailwind's source scan); the scroller's reservation reads the mini player's _measured_ height (see "The scroller reserves the measured bottom chrome"). Related: `PlayerService.playNext()` at end-of-queue now keeps the last track loaded but paused instead of clearing it, so the mini-player (and the persisted session in localStorage, which is wiped when `currentTrack` goes null) survives the queue running out.
- **One-tap smart hunt**: the album-hunt modal (`album-hunt-modal.component`) defaults to the best candidate without a manual pick — `bestCandidate` = top of the server-ranked `filteredCandidates`, `effectiveCandidate` = the user's explicit row selection _or_ the best. The footer (with a match%/slots/size confidence chip) downloads `effectiveCandidate` on a single tap; the per-row list remains for power users. The auto-pick row shows a "★ Best match (auto)" hint.
- **PWA share-target → URL acquire**: `manifest.webmanifest` declares a GET `share_target` (`action: "/search"` — Search moved off `/` when the radio landing became the home route, so the share intent points at `/search`; params `title/text/url`). Sharing a link from a phone lands on the search route; `SearchComponent.ngOnInit` pulls the URL via the pure `extractSharedUrl` helper (`lib/share-url.ts`, scans `url`→`text`→`title`) and auto-starts a yt-dlp/spotdl acquisition, then strips the query params so a refresh doesn't resubmit.
- **Watchlist star**: catalog album cards in search show a star overlay wired to the web `WatchlistService` (`isWatched`/`toggle`); a filled amber star means the backend watchlist poller will auto-acquire it.
- **Catalog artist row — ranked, capped, and legible as an action (issue #669)**: `CatalogService.search` now sorts the deduped artists with the shared `rankBy` comparator (`packages/api/src/services/search-tokens.ts`) instead of handing back Lidarr's raw `artist.lookup` order — this was the one search surface in the repo that skipped it, so "One direction" led with _Uncharted Shores_. Ranking happens **after** the normalized-name dedupe, so the kept casing variant is still the first one upstream returned, and **only when some artist folds exactly to the query**. That guard is not cosmetic: the same `CatalogService` instance is shared with `SingleEnrichmentService`, which searches `"<artist> <album>"` at ingest and then picks the artist portrait with an order-sensitive substring `find`. Such a query can never rank an artist exactly, so `rankBy`'s alphabetical tiebreak would be the only surviving term — it hoists "Zara" above "Zara Larsson" and `setArtwork` upserts the wrong (possibly curated) portrait. No exact hit means nothing to promote, so upstream relevance stands. Pinned by both order tests in `catalog-search.service.test.ts`. The **cap stays client-side** (`ARTISTS_CAP = 5` + `artistsExpanded` / `visibleArtists` / `hiddenArtistCount`, the same head + "show all" idiom as the blended results list, reset in `resetResultSurfaces`): a server-side `.slice()` could drop the scoped artist out of `catalog.artists`, which `scopedArtistMbid()` searches to decide whether the "Load discography" CTA renders at all. Each chip carries a trailing `→` and an `acquire.artistChipAction` title/aria-label ("Show {artist}'s albums") because the click is an **action**, not a filter — it navigates to the local artist page when we already own them, and otherwise loads their Lidarr discography, _which adds the artist to Lidarr_. `data-testid`s: `catalog-artist` / `catalog-artists-show-all`.
- **Library Albums controls (consolidated)**: the Albums view is one control row — search, sort, filters (icons since the one-row toolbar, see "Library tab bar and toolbars") — replacing the previous four stacked rows (6 list-type chips + a client sort dropdown + 11 track-count chips). **Sort** is the _server_ ordering (`albumListType` → `getAlbums(type,…)`, drives the fetch + pagination): Newest / Most Played / Recently Played / A–Z / Random. The old client-side toolbar sort was **removed** because `ListControlsService` defaults `sortField` to the first option and would re-sort each loaded page by name — silently overriding the server order; `gridControls` is now `sortOptions: []` (search-only, preserves order). **Filters** is a `<details>` disclosure (active-count badge) holding **Starred only** (a filter, though the server models it as the `type='starred'` slot — `albumSort`+`starredOnly` resolve to one effective type via `lib/library-filters.ts`), **Min tracks** (a `<select>` replacing the 11 chips, client-side over loaded pages), and **Show hidden** (admin). Resolution logic (`effectiveAlbumListType`/`splitAlbumListType`/`parseMinTracks`/`activeFilterCount`) is DI-free and unit-tested. `data-testid`s: `library-search`/`library-sort`/`library-filters`/`library-filter-{starred,mintracks,hidden,count}`.
- **Library "Songs" tab (`pages/library/library-songs.component.ts`)**: a first-class flat listing of the whole library — the promoted home of what used to be the Downloads "Recently Added" tab. **Online** it reads `GET /api/library/songs` (offset-paginated via a `#songsSentinel` IntersectionObserver), defaults to newest-first (`sort=newest|title|album`), reuses the page's shared `LibraryFilter` (bubbled up through `(filterChange)` so the parent mirrors it to the URL; the local `activeFilter` mirror avoids a one-change-stale fetch since the input propagates a tick later), renders `TrackRowComponent` + the full `SongMenuService.build(song,{removable:true})` menu (queue / play-next / **radio** / go-to-artist+album / add-to-playlist / save-offline / song-info / admin-delete), and offers `createSelection()` + `SelectionBarComponent` multi-select (play / queue / add-to-playlist / save-offline / admin-delete). A leading **server-side text search input** (`data-testid="library-songs-search"`) sends a transient `q` query param alongside sort/filter — the server runs a case-insensitive LIKE against song title, song artist, and album name (`%`/`_`/`\` are escaped so a literal `%` in a query is a literal match, not a wildcard). The input is debounced ~250 ms via `setTimeout` (one refetch per typing burst) and clears pagination on each change. `q` is intentionally **not** part of `LibraryFilter` — it's transient text, not URL-mirrored structured metadata — so it lives only in the component. **Offline** (`[offline]="setup.isOffline()"`) it _replaces_ its list + server filters with the on-device `PreserveService.preservedTracks` through a client-side `ListControlsService` search/sort, surfaces the offline storage bar + Clear all, and trims the per-row menu to backend-free actions (queue / play-next / remove-from-device). The parent `LibraryComponent` forces `libraryMode='songs'` and hides the other (server-backed) tabs via `visibleModes()` when `SetupService.isOffline()`, and the Library route is now reachable offline (removed from `ONLINE_ONLY_ROUTES` / bottom-nav `onlineOnly`; the app-level offline redirect now targets `/library`). The `offline` input is now **live**: `SetupService.isOffline()` reacts to real connectivity (see §Offline / network detection), so the component swaps between the server listing and preserved tracks **mid-session** — a `lastOffline`-guarded effect re-loads the right source when the flag flips (the initial load stays in `ngOnInit`), rather than being frozen at boot.
- **Render-windowing for large lists (`lib/render-window.ts`)**: the app is zoneless, so on big views DOM node _volume_ — not change detection — is the bottleneck. `createRenderWindow(source, pageSize)` exposes a `visible()` slice + `hasMore()` over a full reactive list; the component mounts only `visible()` and grows it via an `IntersectionObserver` on a `#sentinel` (`data-testid=genre-songs-sentinel` / `library-tab-sentinel`). Applied to the genre-detail songs list (was rendering up to 5000 rows) and the library **Artists / Singles / Compilations** tabs (one shared `#tabSentinel` + `growActiveTab()`, since the tabs are mutually exclusive). The _full_ filtered list is kept, so play-all / select-all / search / sort still operate over everything — only the mounted node count is capped. Prefer this over server-pagination when the whole list is needed for bulk actions.
- **Debounced list search (`ListControlsService`)**: the search box binds `searchText()` immediately (responsive input) but the expensive `filtered()` computed (full copy + filter + sort) reads a `debouncedSearchText` that trails by `SEARCH_DEBOUNCE_MS` (200 ms), so a typing burst triggers one filter pass instead of one per keystroke. Matters most on the unbounded Artists list and 5000-song genres.
- **Singles & EPs surfaces (Spotify-style)**: the Albums grid stays album-only; singles/EPs appear in two places. (1) `artist-detail.component` renders a **"Singles & EPs"** card section from `getArtist(...).singlesAndEps`, separate from the album grid. (2) `library.component` has a **Singles** mode (`getSingles(...)`, reusing `ListControlsService` search/sort) alongside Albums/Artists/Genre/Playlists. Cards link to `/library/albums/:id` (the 1–6-track album detail works as-is).
- **Acquire page — acquisition-only (issue #227)**: the page (nav **"Acquire"**, route **`/acquire`**, renamed from `/search`) no longer renders the unified search's `local` results — the former "In your library" album section (`data-testid="library-albums"`, `libraryAlbums` signal) **and** the local "Songs" track finder (`librarySongs`, `TrackRowComponent`, `playLibrarySong`, `toTrack`, `SongMenuService`/`CoverArtComponent` imports) were removed. It now reads unambiguously as "find and add **new** music"; "find what I own" lives fully in the Library tabs/filters + Radio (a search over `library_songs`/`library_albums` still runs server-side — `LibrarySearchProvider`, unchanged, tokenized/diacritic-insensitive — it's just not rendered here). The route rename ships a query-param-preserving `{ path: 'search', redirectTo: 'acquire', pathMatch: 'full' }` redirect so existing `/search?q=…` links/bookmarks/e2e `goto('/search')` still resolve; the `nav.acquire` i18n key labels the desktop nav + mobile `bottom-nav` tab; the component keeps its `SearchComponent` name because the backend is still `/api/search`. When the user can't acquire (a `listener`, or acquisition off deployment-wide per #235), the page shows a **"browse your Library instead" empty state** (`data-testid="search-acquisition-off"`) rather than a blank screen — the reconciliation between #227 and #235. **Left open on #227** (product): whether a lightweight library-find box belongs on the Library page. → [docs/source-agnostic-acquisition.md](docs/source-agnostic-acquisition.md) "Unified search".
- **Network "Songs" lane (acquire one song)**: the raw Soulseek results section defaults to a **song-first view** (a Songs ↔ Folders toggle, `networkView` signal). Pure `lib/song-results.ts` `groupBySong()` collapses the flat per-file network list into one row per song — deduped across peers by normalized `(artist, title)` — and auto-picks the **best copy** (FLAC > other lossless > highest-bitrate lossy, then peer availability: free slot → shorter queue → faster upload → larger size), ordered by query relevance. An untagged `Artist - Title` filename loses its artist half only when every word of it appears in the folder path (`stemArtistSplit`), so it joins the tagged copy of that song. An untagged row's subtitle names an `artistHint` (that prefix, else `folderAlbumIdentity`), which is display only and never part of the key or the score (#1537). A single **Get** downloads that best copy via `handleDownload`→`enqueueDownload`; the per-row state (Get/Queued/Downloading…/↓% when a percent exists/✓ Done→Open) reuses `getSingleDownloadLabel` (labels i18n'd, translator-as-param — see i18n.md item 10). The Folders view (per-peer directories, "Get folder", full-tree browse) is kept for whole-album grabs. `data-testid`s: `network-view-songs`/`network-view-folders`/`song-results`/`song-result`/`song-download`. This is the UX answer to "find me one song" — the catalog/hunt tools are album/EP-only (see [e2e-playground-findings-2026-06.md](e2e-playground-findings-2026-06.md) §F1).
- **Native playlists**: web `PlaylistService` (`services/playlist.service.ts`, signal-based CRUD over `/api/playlists`) drives a **Playlists** mode in `library.component` (create + list) and the `playlist-detail.component` route (`/library/playlists/:id`: play-all, per-track remove, delete). **Add to playlist** is a shared `TrackAction` (`addToPlaylistAction` in `lib/track-utils.ts`) on `TrackRowComponent` available on **every** track list — album detail, search Songs, **genre detail, and playlist detail** (the genre gap was the reported "can't fill playlists from Pop" bug) — calling `PlaylistService.openPicker([songId])`; a global `AddToPlaylistComponent` modal mounted once in `LayoutComponent` renders when `pendingSongIds` is set, listing playlists + an inline "new playlist" create. Reads JOIN `library_songs` server-side, so a song whose file moved silently drops from the playlist.
  - **In-page song search + proposals** (playlist detail, non-curated only): a reusable `SongPickerComponent` (`components/song-picker/`, playlist-agnostic — just songs + an `excludeIds` filter) debounces free-text input **250ms via `setTimeout`/`clearTimeout`** (matching `LibrarySongsComponent`'s convention, no rxjs debounce operator) against `GET /api/library/songs/autocomplete?q=&limit=` (`LibraryApiService.searchSongsAutocomplete`), filters out songs already in the playlist client-side, and emits `add` on pick. Below it, a **"Suggested for this playlist"** list is fed by `GET /api/playlists/:id/proposals?limit=` (`PlaylistService.getProposals`, thin passthrough — no caching) — cheap token-overlap suggestions (title-tokens when the playlist is empty, track-tokens once it has songs). `PlaylistDetailComponent.refreshProposals()` re-fetches after every mutation site that changes membership (`addSong`, `removeSong`, `removeSelectedFromPlaylist`, and the initial `reload()`) so the list naturally stays current without a dedicated poll; sharing/deleting the playlist don't touch it. `playlistTrackIds()` (pre-existing, derived from `visibleSongs()`) is reused as the picker's `excludeIds`, not duplicated.
  - **Multi-select (bulk add, bulk delete, shift-range)**: the genre/album/playlist detail pages have a **"Select"** mode (a per-page `createSelection()` from `lib/selection.ts` — a DI-free signal factory, never a root singleton, so selection can't leak across routes). `TrackRowComponent` renders a checkbox when `[selectable]` is set; its `selectedChange` emits the originating **`MouseEvent`** so hosts read `$event.shiftKey`. **Shift-click range selection** is centralized in `selection.toggleRange(id, orderedIds, shiftKey)` — it tracks the last-clicked anchor and, on a shift-click, sets the whole contiguous range (between anchor and target, in display order) to match the target's new state; pages pass their displayed list (`genreTrackIds()` / `albumOrderedIds()` / `playlistOrderedIds()`). The anchor resets on `enter()`/`exit()`. The shared `SelectionBarComponent` (`components/selection-bar/`) shows "N selected · Select all · Add to playlist · [Delete] · Cancel"; the Delete button is gated by a `canDelete` input with a configurable `deleteLabel` and a `deleteSelected` output. Bulk-add still routes through `openPicker(ids[])` → `addSongs(id, ids[])`. **Delete semantics differ per page**: genre & album delete from the library (admin-only, `canDelete = auth.role()==='admin'`, confirm dialog → `LibraryApiService.deleteSongs(ids)` with partial-failure messaging, optimistically hidden via `TransferService.addDeletedIds`); the playlist page's button is labeled "Remove from playlist" and removes the selected entries from the playlist only (`PlaylistService.removeSong`, files untouched, no confirm). `exit()` always clears the set. The same shared path drives the Library **Songs** tab (online) multi-select. (The Downloads page no longer has a song selection — it's now the Active-feed view only.)
- **Sharing albums, playlists & artists (read-only links + server-side previews)**: a **Share** button (`data-testid="share-playlist"` on playlist-detail, `share` icon on album-detail, `data-testid="artist-share"` on artist-detail) calls `POST /api/share {resourceType}` to mint a short-lived read-only token; the auth middleware allows GET with `share:true`, and `share-view` renders the album/playlist/artist anonymously. Shareable `resourceType`s are `album`/`playlist`/`artist` (the `share_tokens` CHECK constraint is broadened + legacy DBs rebuilt in `db.ts`, same recreate-to-drop-a-CHECK pattern as `acquire_jobs`). **Curated playlists are shareable too** (a share link is itself read-only; `PlaylistService.get` resolves a `kind='curated'` row for any subject). The response→view mapping is the pure, tested `pages/share/share-view.lib.ts` (`mapSharedAlbum`/`mapSharedPlaylist`/`mapSharedArtist`) — the playlist branch reads `pl.songs` (the API returns `songs`, not `entry`, and has **no `owner`**), subtitles with the track count, shows a curated playlist's designed cover (`coverArt` is a `/playlist-covers/<slug>.svg` URL, not a cover id — `coverImage`, bound as is) and otherwise falls back to the first track's cover as the thumbnail (the client `og:image` is always the first track's); **the artist branch** (issue #229) fetches `GET /artists/:id` + `/artists/:id/songs`, renders the id-keyed portrait (404s to the placeholder — no album-cover fallback, by design) + name + album-count subtitle + bio excerpt + a playable song list (so a guest's 5-min window is a real preview, mirroring albums). **Server-side link previews (OG/Twitter cards)**: link-preview crawlers (Slack/iMessage/WhatsApp/Twitter/Discord) fetch raw HTML and don't run JS, so the SPA's Angular `Meta`-set `og:*` tags were invisible. `routes/share-meta.ts` `shareMetaHandler` (mounted at `GET /share/:token` **before** the SPA catch-all) resolves the token **side-effect free** (never sets `first_accessed_at`), looks up the resource name/cover (`resolveShareMeta` — the artist branch reads `library_artists.name` + a BBCode-stripped/clamped bio excerpt via the pure `bioToShareDescription`, OG `type: 'profile'` since OG has no `music.artist`), and injects real OG + Twitter tags into `index.html` (pure `buildShareMetaTags`/`injectShareMeta`/`publicOrigin` — the last honors `x-forwarded-host/proto` for an absolute `og:image`/`og:url` behind a proxy). The `og:image` carries a freshly-minted 10-min read-only **share JWT** (`mintShareJwt`, from `routes/share.ts`) so the authed `/api/cover/:id` serves the crawler's thumbnail; a real browser falls through to the normal SPA on any miss.
- **Share link opened while logged in → own session, not the guest view (issue #230)**: `ShareViewComponent.ngOnInit` checks `AuthService.isAuthenticated()` **first**. A logged-in user calls the auth-gated, side-effect-free `GET /api/share/:token/resource` (`ShareSessionService.resolve`) to map token → `{resourceType, resourceId}` **without** activating the public 5-minute window (`first_accessed_at` untouched, no public token burned), then redirects to the real in-app page (`inAppShareRoute` → `/library/{albums,artists,playlists}/:id`) under their own full session. Access there is governed by their session, not the share clock, so an expired public window still resolves; an unknown token 404s and falls through to the public path. Only an anonymous visitor hits `activate` (the restricted guest experience). Auth-gating the resolve endpoint means only a real session can resolve-without-activating.
- **Post-login redirect back to the requested URL (issue #231)**: `authGuard` captures the attempted URL when it bounces an unauthenticated user (`createUrlTree(['/login'], { queryParams: { returnUrl: state.url } })`); `LoginComponent` reads it in `ngOnInit`, runs it through the pure `sanitizeReturnUrl` (`lib/return-url.ts` — accepts only a single-slash-rooted in-app path, rejecting scheme/protocol-relative/backslash URLs and a `/login` loop, else `/`), and `navigateByUrl`s there after auth (was a hardcoded `navigate(['/'])`). Deep links (shared artist/album/playlist links, bookmarks) now resume to their target after sign-in instead of dumping the user on home. Native pairing/server-select pre-steps are unaffected (they own their own post-auth navigation).
- **History-aware back navigation**: `NavigationService` (`services/navigation.service.ts`) tracks in-app `NavigationEnd` count and exposes `back(fallback)`, which pops browser history (`Location.back()`) when the pure `shouldUseBrowserBack` (`lib/nav-back.ts`) says we've navigated in-app, else routes to `fallback`. `LayoutComponent` injects it eagerly so the navigation that mounts the shell is counted: left to the first detail page to construct, it missed that navigation, and Library → album → Back went to the artist fallback instead of back to Library (#1770). Album, artist and playlist detail hand it to the top bar's back control (see "Top bar") so album → Back returns to the artist you came from; a fresh deep-link falls back to the artist/library.
- **Top bar: the one back control, and on a phone nothing else (#1770)**: pages never render their own back arrow. A page with a back target registers what "back" means in its constructor — `PageBackService.register(handler)` (history-aware pages pass their `goBack()`, which calls `NavigationService.back(fallback)`) or `registerRoute(commands)` for a fixed destination (genre → `/library`, the settings sub-pages and Extensions → `/settings`, what their `routerLink`s did). It is the `PullToRefreshService` shape: a stack, newest wins, spliced out when the registrant is destroyed, so it is route-scoped for free. `LayoutComponent` renders `data-testid="top-bar-back"` (`aria-label`/`title` from `common.back`, a 44px `w-11 h-11` target with `-my-2 -ml-2.5` so the bar keeps its height and the glyph sits on the page gutter) just before the `data-testid="app-brand"` logo, on the same row, at every width. **Below `md` the bar exists only to carry that arrow**: every other control in it is `hidden md:*` and the logo duplicates the bottom tab bar's Home, so `headerDisplayClass(hasBack)` is `flex` with a back target and `hidden md:flex` without — top-level pages (Home, Library, Get, Settings, Admin) have no bar on a phone, and detail pages trade the bar plus their own arrow row (~60px) for the bar alone. Where the bar is gone, a `data-testid="status-bar-scrim"` strip (`md:hidden`, `h-[env(safe-area-inset-top)]`, opaque) keeps a scrolling page out from under the `black-translucent` iOS status bar; `statusScrimVisible` leaves it off on the immersive mosaic home, which pads its own overlay. Modals are unaffected: `measureTopChromeInset` already floors at the safe area. Linux Electron keeps the header at every width — it is the frameless window's drag region and controls. md+ is unchanged apart from the arrow. TV has its own shell and D-pad back (`BackHandlerStack`) and is untouched. Covered by `page-back.service.spec.ts`, the layout spec (real template: the arrow renders beside the brand only while a target is registered and runs it; the `headerDisplayClass`/`statusScrimVisible` cases; Electron keeps the bar), the per-page back-target cases (album, artist, genre, About), and `top-bar-back.spec.ts` (e2e at 412×915: album and artist detail have the arrow on the logo's row with content right under the bar, a tap goes back; a deep-linked album falls back to its artist; a settings sub-page goes to `/settings`; `/library` has no bar; desktop keeps its bar).
- **Seek bar (`app-seek-bar`, native range)**: all three seek bars — the mini-player's desktop bar, the mini-player's **mobile bottom-edge bar** (the only progress UI the mini bar shows on mobile, so it must seek), and Now Playing — share one component, `components/seek-bar/seek-bar.component.ts`, which is a **native `<input type="range">`**. This replaced a bespoke `<div>` + `createPointerDrag` + `getBoundingClientRect` implementation that **kept regressing on Firefox desktop** (click-to-seek and drag did nothing, while touch worked) — the exact failure class of hand-rolled pointer handling. A native range delegates click-anywhere, drag, touch, and **keyboard (arrow keys)** to the browser uniformly across engines, and renders a real **draggable thumb**. The control emits `seek` once on commit (pointer release / keyboard change) so the parent's active-vs-remote dispatch (set `audio.currentTime`, or send a WS `SEEK`) runs once instead of spamming on every drag tick; while scrubbing, the thumb follows a local value so a re-fed `position` can't snap it back. Styling lives in **global** `styles.css` (`.seek-range` + `::-webkit-slider-thumb`/`::-moz-range-thumb`/`::-moz-range-progress`) so the vendor pseudo-elements aren't rewritten by Angular view encapsulation; the fill uses `--theme-accent`. Fill-% math is the DI-free `seekPercent()` in `lib/seek-utils.ts` (unit-tested). The input carries `data-seek` so the mini bar's tap/swipe-to-open handler (`onBarPointerDown` excludes `[data-seek]` targets) never hijacks a scrub; the e2e `player-seek` testid sits on the desktop wrapper to stay unique across the desktop/mobile instances. `createPointerDrag` (`lib/pointer-drag.ts`) is retained for the unrelated mini-bar-open and sheet-dismiss gestures.
- **Now Playing — component split + tabbed Queue/Lyrics panel** (player-standardization plan,
  2026-08, Tasks 2–10): the once-monolithic `now-playing.component` (header, cover art, transport,
  queue, lyrics, and the fullscreen karaoke overlay all inline in one file/template) is now a thin
  shell composing **7 extracted sub-components**, each owning its own template + (where relevant)
  its own local state. Every one of them (plus `PlayerTransportMiniComponent`, the mini-player's
  equivalent extraction) sets `host: { class: 'contents' }` — the shell's root is `fixed inset-0
flex flex-col`, and an unstyled component host element is a `display: block` box by default that
  breaks the flex column (the `flex-1 min-h-0`/`flex-shrink-0` classes _inside_ a child's own
  template become inert, since the shell's flex container only ever sees the host, not those inner
  divs); `display: contents` makes the host transparent so the child's top-level elements
  participate in the parent flex layout exactly as the old inline `<div>`s did (same idiom as
  `DesktopWindowControlsComponent`). Caught late because the symptom (queue panel expanding to full
  content height and overflowing unscrollably instead of filling-and-scrolling) only showed up
  looking at the whole extracted tree together, not any single component in isolation:
  - `NowPlayingHeaderComponent` — drag-to-dismiss handle + device switcher.
  - `NowPlayingCoverArtComponent` — cover art, title/artist, track-info / like / report buttons, `⋯` menu.
  - `NowPlayingTransportComponent` — seek bar, transport buttons.
  - `NowPlayingPanelTabsComponent` — the **Queue/Lyrics tab switcher** (below).
  - `NowPlayingQueuePanelComponent` — the "Next up" list: Clear, drag-reorder, per-row remove.
    Owns `clearQueue`/`removeFromQueue`/`jumpToTrack`/the HTML5 DnD handlers itself
    (`PlayerService.clearQueue()`/`moveInQueue(from,to)`/`removeFromQueue(index)` underneath — all
    three still unit-tested in `player.service.spec.ts`); a drag dims the source row to 40% opacity
    and shows an accent top border at the drop target. Only the ⋮⋮ handle is the HTML5 drag source
    now, and touch has its own gestures — see "Queue row gestures" below.
  - `NowPlayingLyricsPanelComponent` — the in-place karaoke-styled lyrics view.
  - The fullscreen overlay's mic button carries `data-vocal-mode` (`off | basic`) and a
    `vocal-mute-status` caption naming the served mute, both derived from
    `PlayerService.vocalsMuted` — the vocal mute is a synchronous ffmpeg filter, so the flag
    _is_ the mode. It was a four-state machine while the ML stem could be pending
    ([vocal-isolation-spike.md](vocal-isolation-spike.md), issues #603/#1024).
  - `NowPlayingKaraokeFullscreenComponent` — the fullscreen gradient overlay.

  The shell still owns cross-cutting state that spans multiple children (lyrics data/loading,
  `activePanel`, `karaokeFullscreen`, the drag-to-dismiss gesture, the queue-resize gesture) and
  wires child outputs back into its own handlers; a child's own spec covers its internal behavior
  (e.g. `now-playing-queue-panel.component.spec.ts` for drag-reorder), while
  `now-playing.component.spec.ts` covers only the shell's own wiring (which child renders for a
  given `activePanel()`/`karaokeFullscreen()`).

  **Tabbed Queue/Lyrics panel replaces the old toggle**: previously, opening lyrics _swapped out_ the
  queue in place (`lyricsOpen` boolean, `now-playing-lyrics-toggle` button). `NowPlayingPanelTabsComponent`
  now renders two persistent tabs (`data-testid="now-playing-tab-queue"`/`"now-playing-tab-lyrics"`) —
  the queue tab shows a live count badge, the lyrics tab shows an availability dot
  (`data-testid="now-playing-lyrics-dot"`) when lyrics exist but aren't the active tab. The dot
  (`hasLyrics`, gated on the loaded `lyrics()` matching the current track via `lyricsLoadedForId`
  so a track switch can't show a stale positive from the previous track) only reflects lyrics that
  have actually been **loaded** for the current track — lyrics load lazily on first Lyrics-tab open,
  so the dot stays off from the Queue tab until the Lyrics tab has been visited at least once for
  that track; it does not proactively prefetch/probe availability (a known, out-of-scope limitation,
  not a bug). A Track-info sheet reading the current track's lyrics does not light it either: the
  dot follows `loadedForId`, which only the player's `ensureLoaded` moves. `activePanel`
  (`'queue' | 'lyrics'`, `NowPlayingComponent.setActivePanel`) drives which panel renders and is
  **persisted per-device** in `localStorage` (`nicotind:np-active-panel`), same durability as the
  queue-resize state below. `lyricsOpen` (the flag the lyrics-load/color-extraction/auto-scroll
  effects gate on) is seeded from the restored `activePanel` at construction (`lyricsOpen`'s field
  declared _after_ `activePanel`'s, since class-field initialization order matters) — otherwise a
  page load that restored onto the Lyrics tab rendered an incorrect "no lyrics" empty state until
  the tab was re-clicked. The fullscreen karaoke overlay still fully replaces the tabbed area
  (`@if (!karaokeFullscreen()) { tabs + panel } @else { karaoke overlay }`), independent of which tab
  was active when it opened.

  **JIT vitest harness limitation (read before adding a shell-level test that clicks a child)**: the
  harness doesn't propagate a template `[input]="…"`/`(output)="…"` binding across a _nested_
  component boundary (the input-only half of this is already documented in
  `src/testing/signal-input.ts`; the output half is the same underlying gap — confirmed by a minimal
  repro during Task 10: an `output()`-bound child event routed through a _parent_ template binding
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
  from a spec — only their _real-browser_ behavior (e2e) proves that. Where a decision _depends_ on a
  viewChild result (e.g. the auto-scroll effect picking which lyrics container to scroll — in-place
  panel vs. karaoke-fullscreen browse list), pull the decision into a pure function taking plain
  values (`lib/lyrics-scroll-container.ts` `resolveLyricsScrollContainer`) and unit-test _that_, the
  same way `scrollToActiveLine`'s pixel math is pure and tested separately from the DOM wiring that
  calls it.
  - **Lyrics have one owner (#1666)**: `LyricsService` is the only client copy of a song's lyrics.
    The Now Playing panel, phone karaoke and `TvKaraokeComponent` render from it, and the
    **Track-info sheet reads and writes through it too** — its Re-fetch, Edit and Reset used to call
    `LibraryApiService` into a private signal, and since the panel and karaoke stay mounted under
    the sheet and re-ask only on a track or tab change, the karaoke kept the old words until the
    next track and back. The store is **keyed by song id** (an LRU of `LYRICS_CACHE_SIZE` = 20,
    never evicting the current track or an id an open sheet is bound to), because the sheet opens
    for any song row and a single "current track" slot would evict the playing track's lyrics.
    The player's view keeps its names (`lyrics`, `lines`, `plain`, `offsetMs`, `loadedForId`,
    `hasLyricsFor`) as the entry of the id the last `ensureLoaded` named; the sheet uses
    `ensureEntry` (a stored-row read, never the sources, never moving the current track; it returns
    the release the sheet calls on destroy) and `lyricsFor(id)`, and writes through `fetchFor` /
    `save` / `remove`. Every request carries a **per-id token**: an answer for a superseded request
    is dropped, and a slow answer for the previous track lands in that track's entry, never on the
    current one. **No read starts while a write for that id is in flight** (`inFlight: 'write'`):
    the read would answer the row from before the write and, holding the newer token, drop the
    write's answer — a sheet opened mid-Fetch would blank found lyrics, and a track coming back
    mid-Reset would restore the deleted words. A write that fails or is abandoned still frees the
    entry. A re-read is **stale-while-revalidate** — `loading` is true only for a first load,
    so karaoke never blanks mid-song on a refresh. A miss is not cached (the player asking again
    retries the sources, as before). A **forced Re-fetch that finds nothing** answers null while the
    server keeps the row (`fetchSongLyrics`), so the entry keeps its words and the sheet shows
    `trackInfo.lyricsNoNewFound` (`data-testid="lyrics-no-new-found"`) beside them. **Saving an Edit
    on timed lyrics asks first** (`ConfirmService`, `trackInfo.lyricsEditDropsSync`): the server
    stores an edit without `synced` and resets the offset, so the save ends the karaoke sync, and
    the owner chose to make that a decision. `ConfirmHostComponent` sits at `z-[96]`, above the
    sheet (`z-[91]`): at `z-50` the confirm rendered under the sheet that asked. Specs: `services/lyrics-one-owner.spec.ts` (a stateful
    fake server, so both write-through and re-read fixes pass and only a copy that never hears the
    write fails) and `services/lyrics.service.spec.ts`. **The guard** is lint rule
    `nicotind/lyrics-single-owner`: a reference to any of `LibraryApiService`'s lyrics methods
    (`getLyrics`, `fetchLyrics`, `saveLyrics`, `setLyricsOffset`, `deleteLyrics` — a call, a callback,
    a computed key or a destructure) outside `services/lyrics.service.ts` fails `bun run lint`;
    specs are exempt. The pre-B1 sheet trips it four times. Its denominator is in
    [quality-gates.md](quality-gates.md) "Code-shape gates as lint rules".
  - **A change made elsewhere reaches the lyrics on screen (#1666)**: the server announces every
    stored-lyrics write as **`lyrics.changed {songIds}`** on the library event stream, emitted from
    `services/lyrics-store.ts` — the only writer of `library_lyrics` rows a client may hold — so the
    REST routes, the fetch path and the MCP `refetch_song_lyrics` / `sync_song_lyrics` tools all
    reach an open client ([cache-invalidation.md](cache-invalidation.md) "Live invalidation"). The
    one other writer is the song-id carry (`SONG_CARRY_TABLES`, `services/song-curation-carry.ts`),
    which re-keys rows to a freshly minted id no client has read yet and so announces nothing; a
    new writer of rows a client can hold goes through `lyrics-store`. `LibraryEventsService`
    passes the ids to `lyricsChanged$` (`null` after a gap), and `LyricsService.invalidate`
    **re-reads only the entries a surface is showing** — the current track and every id an open
    sheet is bound to; any other cached entry is re-read when a surface next asks for it anyway. The
    re-read is the ordinary stale-while-revalidate `read`, so it **never blanks karaoke mid-song**,
    a read already out is superseded (it may have been served before the change), and a load or a
    write still out is **left to finish** — a read now would drop its answer, the same rule as
    above — with the id remembered in `changedWhileBusy` and re-read when it ends. A re-read inside
    an offset write's window keeps the tapped offset (#1656, below), so this tab's own nudges
    echoing back never rewind a later tap. That echo costs one `GET` per coalescing window after
    each of this tab's own writes; the client cannot tell its echo from another device's write.
    **The TV shell opens the event stream too** (`TvShellComponent.ngOnInit`, as `LayoutComponent`
    does): before, a TV never connected at all, so a phone's edit reached its karaoke only on the
    next track and back. The TV never starts `TransferService`'s poller, so a pushed `job.changed`
    kicks the poller only while it runs (`poller.isRunning()`) — otherwise every TV would poll both
    job feeds on each acquisition anywhere, for a result nothing on it renders. Specs: `services/lyrics-changed.spec.ts` (a stateful fake server; a write
    "from elsewhere" is a row the client did not write) and, server side,
    `lyrics-store.test.ts`, `library.lyrics.test.ts` and `mcp.test.ts`.
  - **The sync tool lives in the lyrics options sheet (#1656)**: one `LyricsSyncToolComponent`
    renders it in both the Lyrics panel and fullscreen karaoke, inside `LyricsOptionsSheetComponent`,
    which opens from an Options button (`lyrics-options-toggle`, `karaoke-lyrics-options`) and starts
    closed each time its view mounts. Its geometry is fixed (three constant-width slots, Reset always
    rendered and disabled at 0), because a Reset that appeared on the first tap moved both buttons
    20 px and the next tap missed. The direction is in words ("Lyrics earlier", "Lyrics 0.25 s
    later"). A held button repeats every `HOLD_REPEAT_MS` after `HOLD_DELAY_MS`, and moves whole
    seconds after `HOLD_COARSE_AFTER_MS` (`holdStepMs`); the write serialization below folds a hold
    into one PATCH. A pointer press steps on `pointerdown`, and the click that follows is ignored
    unless it is a keyboard click (`detail === 0`). Curator-only, and off on TV (`canSync`).
  - **Sync-offset writes are serialized per song (#1656)**: a nudge applies to the entry at once
    and at most one `PATCH …/lyrics/offset` per song is in flight; taps made meanwhile coalesce
    into one write of the latest value, sent when the outstanding one answers (`offsetWrites`,
    `flushOffset`). Each tap used to fire its own PATCH and land its own answer, so the first
    answer rewound the view past a later tap, and two concurrent PATCHes could reach the server in
    either order and leave it on the older one — reproduced in e2e by holding the first PATCH back,
    where the server ended at 250 after three +250 taps. The write is absolute (the route stores
    the value it is sent), so a coalesced or repeated write is idempotent. An answer lands, and a
    failure reverts to the **last value the server confirmed**, only when no newer tap is queued; a
    failure never blocks the next tap. A row read whose window saw a tap — a write outstanding at
    its start or answer, or a tap made while it was out (`offsetTaps`) — keeps the entry's tapped
    offset, since the read may predate the PATCH; checking only for an outstanding write missed a
    read started before the tap and answered after the write finished.
  - **A whole-row write supersedes a queued tap (#1656)**: a Re-fetch, Edit or Delete replaces the
    row, and the server's `setLyrics` resets its offset to 0. While one is outstanding a queued tap
    is held (`rowWrites`) — sent first, it would land before or after the reset in either order;
    when the answer replaced the row (`rowReplaced`) the tap is dropped, since it was measured
    against the old LRC, and a PATCH answer still in flight is stale (`rowEpochs`) and neither
    lands nor reverts. A Re-fetch that finds nothing keeps the row, so the held tap goes out. The
    one PATCH already in flight when the row write starts can still be served after the reset —
    the client cannot see the server's order, and the screen shows the new row's offset. Specs:
    `lyrics.service.spec.ts` "the last tap wins (#1656)" (a fake server that applies a write when
    it serves it), "sync offset vs a whole-row write" and `mobile-ux.spec.ts` "rapid sync taps end
    on the last tap".
  - **Manual queue resize** (`data-testid="now-playing-queue-resize"`): the notch is the visible affordance for a resize the sheet's body gesture serves from **anywhere** — swipe up on the cover, transport, tabs or panel to pull the panel area **taller**, which **shrinks the cover art** to make room (the panel is `flex-1`, so shrinking the cover grows it); swipe down to collapse it (see the mode table above). The handle is **shell-owned, rendered above the Queue/Lyrics tab bar** — it originally lived inside the queue panel, so after the tab switcher shipped it vanished on the Lyrics tab and users reported the feature as lost; hoisting it makes it work for **both** panels (the queue panel's old `resizing` input / `resizeStart` output API is removed). `queueExtraHeightPx` (px the cover has shrunk from its 320px max, clamped to `[0, 320]` — the floor is 0 since #993) feeds `coverMaxPx = 320 − queueExtraHeightPx`, bound to the cover's `max-width`. The chosen size is **persisted per-device** in `localStorage` (`nicotind:np-queue-extra`) and read on construction, so it survives reload. Unit-tested in `now-playing.component.spec.ts` → "sheet body gesture (mode table)", "queue resize (drag handle)" + "hoisted resize handle (shell-owned)"; the Lyrics-tab drag and the swipe-from-the-tabs path are covered end-to-end in `mobile-ux.spec.ts`.
  - **Desktop side panel (`lg:` ≥1024px, Spotify-like)**: the sheet becomes two columns — cover art + transport centered in a flexible left column, the Queue/Lyrics panel (with its tab switcher) an always-visible right column (`data-testid="now-playing-body"` wraps both). **The border between them is a splitter** (`data-testid="now-playing-side-resize"`, `role="separator" aria-orientation="vertical"`, `tabindex="0"`, 8px hit area around a 1px line): drag it, or with focus use ArrowLeft/ArrowRight (±16px) and Home/End (min/max); double-click resets. `sidePanelWidthPx` defaults to 380, clamps to `[300, 640]` and never more than half the viewport, and is **persisted per-device** (`nicotind:np-side-width`). It rides a **`--np-side-w` CSS var** (`lg:w-[var(--np-side-w,380px)]`) rather than an inline width, for the same reason the cover cap does. Because every extracted child uses `host: {class: 'contents'}`, a grid/flex on the root would place each child's _inner_ element as an individual item — so the shell adds two **group wrappers that are `contents` below `lg` and real flex columns at `lg`** (`class="contents lg:flex …"`): below the breakpoint the wrappers dissolve and the mobile stacked layout is untouched by construction. The breakpoint is `lg`, not `md` (the app's nav-chrome fork) — a portrait tablet at 768px lacks room for cover + a 380px column, and `lg:` is where the app's grids already assume real horizontal space. The mobile drag-resize notch is `lg:hidden` and the body gesture's resize mode is skipped at `lg` (`matchMedia('(min-width: 1024px)')`); the stored cover shrink is mobile-scoped: `coverMaxPx` rides a **`--np-cover-max` CSS var** (`max-w-[var(--np-cover-max,20rem)] lg:max-w-80`) instead of an inline `style.max-width`, which would beat every class including the `lg:` cap. Karaoke fullscreen is untouched (own `fixed inset-0 z-[70]` overlay at all widths). Covered by `now-playing-desktop.spec.ts` (e2e; jsdom has no layout engine) + the cover-art spec's var-binding case.

- **Mini-player transport** (player-standardization plan, Task 11 — the plan's final task):
  `PlayerTransportMiniComponent` (`components/player/player-transport-mini/`) pulls the
  prev/play-pause/next button cluster out of the mini bar (`player.component`) — a
  pure relocation of markup already covered by `appTvNavGroup`/`appTvNavItem` D-pad nav, not new
  coverage. `playing`/`buffering` stay shell-owned inputs (the shell branches play/pause between
  local and remote-device dispatch). It used to flank those three with shuffle and repeat, which
  injected `PlayerService` directly; both are gone (see "Shuffle and repeat are not in the UI"), so
  the component is inputs and outputs only and injects nothing.
  Hit the **same JIT harness gap documented above** for Now Playing's decomposition: a parent-level
  spec assertion that set `bufferingVisible` and expected the mini-player's play/pause button to
  render the spinner via the `[buffering]="showBuffering()"` binding failed with `NG0303` (binding
  never reaches the nested component in this harness) even though the value the binding _carries_
  (`PlayerComponent.showBuffering()`) is correct — confirmed with an isolated minimal repro, not
  assumed. Per the same resolution as Task 4/10: the DOM-rendering assertion moved into
  `player-transport-mini.component.spec.ts` (asserted via direct component creation, no cross-boundary
  binding), and `player.component.spec.ts` now asserts only the shell's own `showBuffering()` computed
  resolves correctly — the wiring itself is proven by e2e (`packages/e2e/tests/player.spec.ts`
  "player controls"), which has no such gap.
- **Playback auto-radio**: `PlayerService.radio` (persisted in the player state snapshot) keeps playback going — a constructor `effect()` watching `queue().length` calls `replenishRadio()` whenever the queue sits below `radioQueueTarget` (and `repeat==='off'`), appending fresh tracks (de-duped against current/queue/recent history). It asks for the shortfall, not a fixed batch, so the queue holds one depth as it is consumed rather than draining and refilling in lumps — see [radio.md](radio.md) "A radio queue has a depth, not a batch size". The `RadioProvider` registered by `RadioSourceService` calls `GET /api/radio/next` with the session's anchor as seed (`PlayerService.radioAnchor`: the song or list the radio was started from, never the playing track — see [radio.md](radio.md) "A radio is about its anchor", #1277) — the server scores candidates by BPM, key (Camelot), genre, year, duration, and artist diversity, returning musically similar tracks. Falls back to shuffled recent songs when there is nothing to anchor on yet. `PlayerService` stays HTTP-free via the `RadioProvider` callback. Toggle lives in the Now Playing sheet. **Filter "vibe" radio**: `PlayerService.radioFilter` (a persisted `LibraryFilter`, set by `startRadioWithFilter(tracks, filter)`) makes the provider replenish via `getFilterRadio(filter,…)` so a mood/genre/bpm radio stays in-vibe; it's cleared when seed radio starts or radio turns off. → [docs/radio.md](../docs/radio.md)
- **Home view switch (`pages/home/`, the home route `''`, #1300)**: the route is a thin `HomeComponent` shell that renders the view the user chose — the mosaic (default) or the classic shelves — and a _Shelves | Mosaic_ `HomeViewSwitchComponent` (`role="radiogroup"`, `data-testid="home-view-switch"` / `home-view-mosaic` / `home-view-shelves`, 44px targets) in the **top-left corner**. **The switch is mounted once (#1667)**, in one in-flow `home-view-switch-anchor` wrapper _before_ the `NgComponentOutlet`, outside the view swap — it used to be two instances in an `@if`/`@else`, so a toggle destroyed the clicked button (dropping keyboard focus) and re-created it somewhere else (16px from the edge on the mosaic, inside the centred 768px `page-shell` column on the shelves, ~600px apart at 1920px). The wrapper's classes come from the pure `homeSwitchAnchorClass(view)`: `px-4 md:px-6` puts the switch on the header's content edge (16px, 24px from `md`) and `pt-3` 12px below `<main>`'s top in both views; only the mosaic adds `max-md:pt-[calc(0.75rem+env(safe-area-inset-top))]`, because below `md` neither view has the header (which carries the safe area) and only the shelves sit under the layout's status-bar strip (see "Top bar"). On the mosaic the wrapper overlays the `absolute inset-0` stage at `z-10` and is `pointer-events-none` (the switch host re-enables them) so its padding never eats a drag; on the shelves the same box pushes the page down, so the first block never sits under it. Since the header behaves the same in both views at every width (hidden below `md`, #1770), the switch is identical relative to `<main>` at every width and pixel-identical in the viewport from `md` up. The switch floats semi-opaque (`bg-theme-surface-2/90`) with **no blur**, per the blur and stacking contract (#1649, [design-patterns.md](design-patterns.md)): a blurred layer there sat under the open Now Playing sheet's top band. It follows the Library-tab pattern (see "Library tab bar and toolbars"): every option has an icon (`homeViewIcon` — `layout-grid` for Mosaic, `rows-3` for Shelves), only the active one shows its label (`data-testid="home-view-label"`), the inactive label stays as `sr-only` plus a `title`, and an icon-only option is a `min-w-11 min-h-11` square. The control's width changes on a toggle; its left edge does not. Each radio is its own tab stop activated by Enter/Space — there is no arrow-key roving. The choice is `homeView` on the per-user preferences door (see "Per-user preferences"), so it follows the user across devices and the per-device mirror makes the first paint after a reload already the chosen view. **Only the chosen view's chunk is loaded**: `HOME_VIEW_LOADERS` is one `lazy()` import per view, resolved in an effect on `view()` and rendered through `NgComponentOutlet`; the other page is never fetched and its data (`getRecentPlays`, `getListRadio`, `getRandomSongs`, `getStats`) never requested until the user switches, and switching swaps the component in place — same URL, no navigation. The shell's host is `contents` so the mosaic's `absolute inset-0` stage still positions against `<main>`. Below `md` neither view has the top bar (it carries only a back target — see "Top bar"); the shelves, a scrolling page, get the status-bar strip (`statusScrimVisible`) and the immersive mosaic does not. `/classic` stays as a direct link to the same shelves component and does not touch the preference. `homeViewOf(null)` is `'mosaic'`, so nobody who never chose sees a change. TV has its own home (`tvShellRoute()`). Covered by `home.component.spec.ts` (the unchosen loader is never called; a switch patches the door and swaps in place; one anchor outside the view, the same switch node and the same focused button across a toggle; `homeSwitchAnchorClass`), `home-view-switch.component.spec.ts` (icons, active-only labels, the 44px floor on an icon-only option), the `HomeViewSwitch` stories (`AnchoredMosaic` / `AnchoredShelves` render it in the anchor wrapper over a stand-in for each view, with `homeSwitchAnchorClass` from its leaf `home-switch-anchor.ts`), the `statusScrimVisible` cases, and `home-view.spec.ts` (e2e: switch, server-side persistence, reload, no `/api/history/stats` request while on the shelves, no bar on a phone and the strip only on the shelves; the switch's box is unchanged across a toggle at 768/1280/1920px and on the header brand's x, the same x and `<main>` offset on a 375px phone, the shelves never start under it, a keyboard toggle keeps focus, and only the active label is shown).
- **Mosaic home (`pages/mosaic-home/`, rendered by the home shell for the default `mosaic` view)**: the post-login surface — one infinite, pannable field of tiles where **every tile starts a radio**. It is composed from the sources the classic landing uses (keep the vibe, taste breakers, recently played, curated playlists, vibe presets, top genres — not Resume, see "The recipe is a draw" below), collapsed into one surface with one verb. The classic landing used four playback verbs depending on which shelf a cover sat in (`startRadio`, `playWithContext`, `startRadioWithTracks`, `startRadioWithFilter`); here `MosaicAction` has three shapes and all three are radio starts. Recently-played is the one source whose behaviour changed: it no longer uses `playWithContext`, so tapping it no longer keeps the shelf as a queue. **First run (#1739):** before the lanes are drawn the page asks `getAllSongs(1)` whether the library holds anything. An empty answer renders `<app-empty-library>` (below) instead of a field of tiles that would each play nothing; a _failed_ check is not taken for an empty library. The vibe presets are narrowed by `playableVibes()` (`lib/vibe-availability.ts`), which probes each preset's filter for one matching song, so on a server without the analysis sidecar the mood and audio-feature vibes are hidden and only the ones the tags can answer (e.g. 120bpm+) remain. A probe that errors keeps its vibe.

  **The geometry is pure and unit-tested; the component owns only the loop.** `lib/mosaic-tiles.ts` turns sources into scored tiles, `lib/mosaic-packing.ts` packs them into a square patch, `lib/mosaic-lens.ts` projects that patch to the screen — none of the three touches the DOM, matching how `lib/vfx-scene.ts` is pure while `now-playing-vfx.component.ts` owns the canvas.

  **The plane is a torus.** Panning never runs out of content because the packed patch repeats every `W` in both axes; the renderer draws copies at `x + i*W, y + j*W`. That only works if collisions are tested with _wrapped_ distance, so a tile near the right edge knows about one near the left — they are neighbours once the patch repeats. Two constants that a demo can hardcode must be derived here: `patchSide()` sizes `W` from total tile area (a fixed side leaves a 12-tile library packed into one corner with nothing to pan through), and `cellCount()` keeps the collision hash's cell at least one max-tile-plus-gap wide, because the `fits` test only inspects the 3×3 cell neighbourhood and a smaller cell silently misses collisions.

  **A torus has no centre, so the packing must not have one either.** The scan order was once centre-out — candidates sorted by distance from the patch middle, first fit wins. First-fit from a centre packs an _inscribed disc_ and leaves the square's corners empty, and tiling that patch merges four empty corners into one void every `W` pixels: the plane visibly repeated as blobs separated by channels. Measured over the real tile mix, the old ordering put **zero** tiles outside the inscribed disc at every tile count and left channels 30–120px wide; it also degraded badly with size, dropping all eight of its largest tiles into a _single_ block of nine at 120 tiles. `positionRank` replaces it with a fixed hash permutation — centre-free, and still deterministic so a tile does not move between reloads — and `CANDIDATE_SAMPLES` adds Mitchell's best-candidate: of the first few positions that fit, take the one farthest from its nearest neighbour. Random alone would remove the void but clump; the spacing rule is what makes the field _even_. Two consequences worth knowing:

  - **Order became largest-first.** The old alternation (biggest, smallest, second-biggest…) existed to stop big tiles clumping centrally, which was an artefact of the centre-out scan. Once spacing spreads them by construction, order is free to serve packing instead — and it must: spreading tiles evenly fragments the free space, so interleaving sizes strands the largest tiles late and the packer **silently drops** them (81 tiles became 74). A big tile needs a big gap and gaps only shrink, so the biggest goes first. `packMosaic` is spec'd across 1–120 tiles because 40 packed fine while 81 lost seven.
  - **It is ~16× faster.** The old ordering sorted ~163k candidates with `Math.hypot` on every comparison, costing 3.5s per pack at a desktop stage (21.7s at 200 tiles) — paid on load _and on every resize tick_. An integer hash sort brings the same case to 224ms.

  `mosaic-packing.spec.ts` asserts the two properties that make the field continuous — tiles reach the patch corners, and no empty channel crosses it — rather than the mechanism. The test they replaced asserted that placement _order_ interleaved sizes, and passed happily throughout the clumping above.

  **The geometry repeats; the content does not.** Repeating the home patch's _content_ made exploring feel like a loop — pan far enough and the same eighty tiles came round again. So only cell `(0,0)` shows the curated home tiles; every other torus cell fills the same slot geometry with its own fresh batch, fetched from `GET /api/library/random` the first time the cell is sighted (`enterCell` → `loadCell`), scored with the caller's own play weights and mapped best-score-into-biggest-slot by the pure `assignSongsToSlots`, so tile size keeps meaning "hotter" out in the field. While a batch is in flight the cell's slots wear a pulsing `.skeleton-block` face; a failed or empty fetch degrades that cell to the home copy (`'base'`) rather than a hole — and deliberately never retries until the cell is evicted, so a down server cannot become a fetch loop. Cells are cached (capped at `MAX_CACHED_CELLS`, stale-evicted by frame stamp) so panning back shows what you saw; an evicted cell simply refetches, which for a random batch loses nothing. Newly surfaced tiles are mirrored into the hidden accessible list (`discovered`, capped).

  **The lens is a logarithmic fisheye (#1638).** It began as an orthographic azimuthal projection (screen radius `R·sin θ`, scale `cos θ`); the owner asked for the centre to grow much more, so inside the same rim the radial profile is now logarithmic: at `u = r / (R·THETA_MAX)` the screen radius is `R·sin THETA_MAX · ln(1 + K·u) / ln(1 + K)` and a tile's scale is that curve's **slope**, `CENTER_SCALE / (1 + K·u)`. Scaling by the slope rather than by the radius ratio is what keeps radial neighbours from colliding as they are magnified. `FISHEYE_K` (3.5) is the one knob: it gives `CENTER_SCALE` ≈ 1.85 and leaves `RIM_SCALE` at the old `cos THETA_MAX` ≈ 0.41, so the visible field, its culling and the rim blur's circle are unchanged. Opacity fades over the outer `FADE_BAND` of the radius. Culling uses the _drawn_ half-size, since a magnified tile reaches the screen from further out. `PAN_GAIN` is divided by `CENTER_SCALE`, because one plane px at the centre is `CENTER_SCALE` screen px and the content under the finger must still track it. `mosaic-lens.spec.ts` pins the shape: `1/scale` grows linearly with distance, and screen distance is concave. **The fisheye magnifies the gaps along with the tiles**, so packing at full `tileSize` left a sparse, magnified field (the owner's desktop screenshot showed three tiles). Tiles are therefore packed at `tileSize × TILE_BASE` (`1.1 / CENTER_SCALE` ≈ 0.6), which lands the centre tile at about its pre-fisheye size and makes everything around it denser; covers are requested for `size × CENTER_SCALE`, the size the centre draws them at. Small faces then clipped their labels under fixed 12px padding and 13px titles, so a face's padding (`--face-pad`), subtitle size (`--face-sub`) and title size are set per face from its packed size, clamped to the old values at the top. **Tile size scales sub-linearly with the screen (#1642)**: `tileSize` is fed `sizingReference(stageMin)` — square-root scaling around `SIZING_PIVOT` (640) — rather than the stage size itself, because linear sizing made tiles tiny on a phone and huge on a large monitor (about 1.28× on a 390px phone, 0.89× on an 800px stage, 0.70× on 1300px). The lens radius stays the real stage size.

  **The recipe is a draw, not a fill (`LANE_MIX`).** The first cut filled every lane to the brim — twenty recent plays, ten keep-the-vibe variations, twenty-four random picks — and real use showed the cost: more than half the song tiles were the listener's last session and its few artists (one album listen is up to twenty tiles of one artist, since `recentPlays` collapses per _recording_, never per artist), and because history barely moves between two mornings the wall was the same on every visit. `LANE_MIX` in `lib/mosaic-tiles.ts` is now the second hand-tuned block beside `SCORE_WEIGHTS`. Each lane still fetches its whole pool — `recent.pool` is twenty plays, `keepVibe.pool` twenty variations seeded by _all_ twenty plays, drawn or not — but shows only `tiles` of it (ten each, half), drawn uniformly without replacement by `drawFrom`, a partial Fisher–Yates with an injectable rng so the spec can seed it. So each recent play has even odds of being on the wall today, no two visits compose the same wall, and taste breakers fill the rest of `songSlots` (54, the old total), skipping anything either pool holds — a play that lost its draw must not walk back in as "random", or the caps would be a fiction. With no history at all the breakers take the whole budget, which is why they are fetched at `songSlots`: a fresh install still gets a full field. **The Resume tile is gone**: the mini-player already is the one-tap continue, and a fixed score-1 tile of the track you are already hearing was the largest thing on the wall on every visit. The classic landing keeps its Resume card. Two things this deliberately leaves alone, for the record: `GET /api/library/random` is uniform over _songs_, so a big catalog still wins the breakers and every discovery cell in proportion to its track count; and `ownPlayShare` still sizes any song by an all-time top artist near the maximum. If one catalog keeps recurring, the next step is an artist-stratified draw plus a per-artist cap, not a smaller pool.

  **Tile size is a ranking.** `scoreTile` blends `Song.popularity` with the caller's own play counts from `GET /api/history/stats`. Popularity is absent for most rows (mid-backfill, and ~half the library has no recording-MBID tag to score against), so an unknown value **redistributes its weight** onto plays plus a stable per-key hash rather than substituting a constant — a `?? 0.5` default would give almost every tile the same size and flatten the mosaic into a uniform grid. `SCORE_WEIGHTS` is the one block meant to be tuned by hand.

  **A tap centres the tile instead of raising the sheet (#1638).** `start()` no longer opens Now Playing; the mini-player is the one tap to it. A tap on the stage glides the camera to the exact copy that was tapped (`focusElement`: packed position plus the copy's torus offset from `data-cell`), a start from the accessible list to the home copy nearest the camera (`focusTile`). The glide is a `GLIDE_MS` ease-out driven by the frame loop on an injectable clock (`now`), instant under `prefers-reduced-motion`, cancelled by the next drag, and counts as motion for the rim blur. **The playing tile is sticky**: the centred tile becomes the `anchor`, and while it is what is playing (`lockHolds`: the seed song itself for a song or downloaded tile; any playback for a vibe, genre or playlist radio, which has no single track to compare) a drag only gives by `LOCK_GIVE` under the finger and springs back on release (`SPRING_BACK_MS`) until it covers `lockBreakPx(stageMin, pointerType)`, where it breaks free, pans normally and drops the anchor. The detent is a share of the stage's shorter side — 14% for touch, 9% for a mouse or pen, clamped to 40–140px (~55px on a phone, ~75px on a desktop stage) — so it feels the same across viewports, and a thumb, which wobbles and sweeps further, has to mean it more than a wrist. A fixed 24px was tried first and felt too short; 5px, the first suggestion, sits under the 6px tap slop, where travel is a tap and a detent could never be felt.

  **Tap versus drag** is a 6px slop test on accumulated pointer travel, checked in a single delegated `click` listener on the stage. Without it every attempt to pan ends in a pointerup on a tile and starts a radio; delegation (rather than a handler per element) is required because the pool recycles elements out from under any handler bound to one. Pull-to-refresh needs no opt-out: the layout gesture is gated on `PullToRefreshService.hasHandler()` and this page registers no handler.

  **A release comes to an actual stop.** Inertia decays by `FRICTION` per frame with a hard snap to zero below `REST_EPSILON` (`decayVelocity` in `lib/mosaic-lens.ts`) — exponential decay alone never reaches zero, so the camera crept sub-pixel forever and read as "it never stops". The demo's idle drift was removed for the same reason: a resting mosaic is genuinely at rest. **And a resting mosaic draws nothing**: `frame()` asks for another frame only while a drag is held or the coast is still moving, and everything that changes what a frame would show calls `wake()` — pointer input, `repack()` (tiles, resize), a discovery cell's batch landing, the stage coming back on screen. The loop used to recompute the whole lens 60–120 times a second at rest to write nothing. `wake()` is idempotent (`raf === 0` means no frame is pending).

  **Press and hold a tile** (450ms within the tap slop) opens its menu at the finger (see "Tile interaction standard" — Song info is an item of a song tile's menu), with a suppress flag eating the click that follows the release so the hold does not also start a radio under the menu. Tiles with no menu (the downloads shortcut, an offline tile) do not arm the timer. Hovering with a fine pointer lifts the face slightly: faces rest at `scale(0.97)` and grow to `1` on hover, because `contain: strict` clips paint at the tile box so a scale past 1 would crop, not lift — the same reason `.mosaic-pop`'s fill is `backwards`, letting the animation release the transform once the pop lands.

  **A face's long names reveal themselves (#1707).** The title and subtitle are one line each (`.mosaic-name`, marked `data-overflow-reveal`), and the frame that finds the field at rest gives every face in the lens that has none yet its `OverflowReveal`s via `attachOverflowReveals`, with the pooled tile element as the row. On touch that plays one pass once the field is still; with a mouse it plays while the tile is hovered; under reduced motion a tap on the name wraps it and does not start the radio (see "Names are never unreadably truncated"). The attach waits for rest because a reveal reads layout as it is built, and the field is still anyway before a touch pass may play. Rewriting a face (`innerHTML`) destroys its reveals first, and a repack or the page's teardown destroys them all. They use the module's shared IntersectionObserver and ResizeObserver and no MutationObserver, because a face is replaced whole, never its text in place. The title was a two-line clamp and is now one line: a clamp wraps instead of overflowing sideways, so the reveal could not move it. Measured with every song tile renamed to a long title and artist (390×780 touch, 4× CPU throttle, six reps of three pans and a 2.5 s rest each): frames over 25 ms went from 0.28% to 0.41% of all frames (two runs of the fix), the longest frame from 50 ms to 67 ms (one rep in six before, two in twelve after), and layouts per rep rose from about 47 to about 102, most of it the reveal passes themselves running at rest.

  **Depth (#1638)** comes in three layers, none of them per-tile work in the loop:
  - **Every face casts a soft shadow** (`--theme-elevation-tile`) and has no border: a 0.5px stroke on a lens-scaled layer rasterised into a light, uneven fringe around the rounded corners. The same paint clip means a shadow outside the box is cut off, so each pooled box is the packed face plus `TILE_INSET` on every side, translated back by the inset so the face lands where the lens put it, and the face sits `--mosaic-inset` inside it (the component sets the variable from the constant). Packing, spacing and the lens stay in face units — `GAP`, `DENSITY` and the field's look are untouched; only the box grew.
  - **The edges blur.** The lens already shrinks and fades the rim; `.mosaic-rim` adds blur toward the viewport edges as **one** masked `backdrop-filter` layer over the stage, tinted 30% toward `--theme-bg`. The mask is a **circle reaching the stage's farther edge** (clear inside 55%, full at 100%) because that is about where the lens draws its rim (`R·sin THETA_MAX`, with `R` the stage's shorter side): a portrait phone's side edges are still near the lens centre and stay sharp, while its top and bottom recede. A viewport-shaped ellipse was tried first and blurred a phone's side tiles halfway to the middle. A per-tile `filter: blur()` was rejected because it would change on every tile every frame of a pan and re-rasterise each layer — the opposite of a loop that writes only transforms. **It is drawn only at rest.** Measured on a weak-GPU stand-in (SwiftShader on 2 cores, 4× CPU throttle, 390×780@3×, 6 interleaved runs per variant), a blur over the moving field took a pan from 2.4% to 9.2% dropped frames, with the shadows costing nothing measurable; on a real GPU (Radeon 760M) no variant differed. So `setMoving` puts `is-moving` on the stage on the move that crosses the tap slop (so a tap or a still hold never flickers it) and clears it on the frame that finds the field at rest; `.is-moving ~ .mosaic-rim` hides the blur **at once** (a fade-out measured as a hitch at the start of every pan) with `visibility: hidden` so it is not drawn at all, and it fades back in at rest. **It also stands down while Now Playing covers the field** (#1649): `covered` (the sheet open or lifted by the mini bar's drag, held until its 300 ms slide away is over) puts `mosaic-covered` on the root, and `.mosaic-covered .mosaic-rim` hides it at once — a `backdrop-filter` layer left under the sheet is the in-page exception of the blur and stacking contract ([design-patterns.md](design-patterns.md)). Gone under `prefers-reduced-transparency` and on E-Ink.
  - **The tile whose menu is open is lifted** (`markHeld`, from a hold, a right-click or the ⋯): it gets `.is-held` — `z-index` above a `.mosaic-veil` that fades the rest of the field toward the theme background, a `scale(1.04)` face with `--theme-elevation-raised` and a `--theme-glass-edge` ring — and the root gets `.mosaic-holding`, which also hides the rim blur so a held tile near the edge stays sharp. The held tile alone drops paint containment (`contain: layout size style`) so its lift and shadow can overflow its box; it is one tile, at rest. The veil is one layer inside the stage, so dimming the field is a compositor opacity change rather than a repaint of every face. The lift follows the menu: an effect on `EntityMenuService.state` lets it down on any close (Escape, outside tap, Back, running an item), a second menu moves it, and a held tile parked by the pool or dropped by a repack is let down with it.

  **Offline, the mosaic becomes the downloaded set.** Every source it draws from is a server read, so losing the network mid-session used to leave a wall of dead tiles — and the app worked around that by _navigating away_: `/` was the one entry in the shell's `ONLINE_ONLY_ROUTES`, `onlineOnly` in the bottom tab bar, and `app.ts` actively redirected to `/library` whenever `isOffline()` flipped. All three are gone. `buildOfflineTiles` fills the field from `PreserveService.preservedTracks` — IndexedDB, no token, no request — and the swap runs in both directions, so the page a listener is on survives a tunnel and comes back when the signal does. Four things this settles:

  - **Radio is not offered, because it cannot work.** Every radio provider fetches its next tracks from the server, so a tile promising radio here would fail on tap. The offline action is `playWithContext` over the whole downloaded set under the `saved-offline` context — the same verb the Library's offline Songs tab uses, so playback runs on through the device's music instead of stopping after one track. This is the documented exception to "every tile starts a radio", and `mosaic-tiles.spec.ts` pins it: offline, every tile's action is `offline` or `route`.
  - **One tile navigates rather than plays.** The `downloads` tile routes to `/library`, which force-selects its Songs tab offline and so _is_ the downloads list; `/get?tab=downloads` is the acquisition feed and needs the server. It skips the playback busy-guard and never raises Now Playing.
  - **Covers are omitted, not requested.** A cover id would build an `/api/cover/:id` URL that cannot resolve, and a face with no `coverArt` already falls back to its deterministic placeholder gradient. Reading cover blobs out of IndexedDB per tile would put object-URL lifetimes inside a recycling pool, which is where leaks live.
  - **Discovery cells stand down.** `enterCell` returns `'base'` immediately while offline rather than firing one request per sighted cell that can only fail.

  Sizing falls back to what the device itself knows — how recently each track was downloaded, plus the usual stable jitter — since popularity and play stats are both server reads. The reload effect tracks `NetworkStatusService.reconnects` _alongside_ `isOffline`, because signals coalesce: a fast offline→online pair flushes one run carrying only the final value, so the edge is invisible to a diff of `isOffline` alone. A load token guards the swap, so an online load started before the drop cannot land on top of the offline set that replaced it.

  **Loading is shape-matched.** The initial fetch renders the `mosaic` variant of `SkeletonComponent` — a deterministic scatter of pulsing squares where the field will appear (`mosaicSkeletonSpot`), not a list skeleton borrowed from another page. On the home route the layout also collapses the top bar below `md` (`headerDisplayClass` in `layout.component.ts`): every control in it is `hidden md:*` there anyway — nav lives in the bottom tab bar — so on a phone it was a dead brand row eating a strip of an immersive, full-bleed surface. Every other route keeps the sticky header.

  **Pooled tiles cannot hold a focus order**, so the page also renders a visually-hidden `<ul>` of the same tiles as real buttons calling the same `start(tile)`. That list is a plain Angular `@for`, which is also what the e2e spec drives — pooled tiles are recycled mid-interaction and are a flaky click target. Tile markup and `.mosaic-*` styles live in global CSS (`styles.css`), since elements created by the loop carry no view-encapsulation attribute; `contain: strict` on the stage and each tile is what keeps the field at one paint per frame. The loop writes transforms and never a signal, and the app is zoneless, so it costs no change detection and needs no `runOutsideAngular`. `prefers-reduced-motion` disables the pop-in, the hover transition and the veil/rim fades. `data-testid`s: `mosaic-home`/`mosaic-stage`/`mosaic-tile`/`mosaic-tile-list`/`mosaic-tile-link`. → [docs/radio.md](../docs/radio.md)

- **Classic radio landing (`pages/radio-landing/`, route `/classic`, and the home shell's `shelves` view)**: the shelf-based landing the mosaic replaced; since #1300 a user can make it their home with the switch above, and it stays reachable at `/classic` as a direct link. Built to _start listening in one tap_ — recover a mood or make a new one. Six blocks: (1) **Resume** — a card seeded from the persisted last track (`PlayerService.currentTrack`); tapping `startRadio`s it and the block **disappears** (a local `resumeDismissed` signal; hidden entirely when there's no last track). (2) **Keep the vibe**, (3) **Taste breakers**, (4) **Recently played** and (5) **Tastemakers** — four self-hiding shelves, all documented in [docs/radio.md](../docs/radio.md); the page reads the recently-played rows off the child via `viewChild` and feeds them to both (2) and (3), so the history is fetched exactly once. (6) **Start a radio** — one-tap **vibe presets** (Happy/Chill/Party/Energetic/Danceable/Uplifting/120bpm+/Acoustic, each a canonical `LibraryFilter` over `MOOD_VOCAB`/perceptual buckets/bpm) + top-genre tiles. Each tap calls `getFilterRadio` and hands the result to `startRadioWithFilter` (empty match → a neutral toast, never an error). The presets row is narrowed by the same `playableVibes()` probe as the mosaic (#1739): it renders every preset until the probe answers, then only those with a match.
- **Empty library (`components/empty-library/`, #1739)**: the first-run state shared by the mosaic home and Library → Songs (when no filter or search narrows the list). It says the library is empty, shows admins the server's music folder (`GET /api/admin/library-location`; non-admins never ask), offers **Scan library** (`POST /api/system/scan`, with a started/failed status line), and links to Add for users with `canImport()`. Pinned by `e2e/tests/empty-library-first-run.spec.ts`, which simulates the empty library at the API because the suite's server is seeded.

  **The two tones are the design** (`components/vibe-tile/`). One `VibeTileComponent` renders both rows so they cannot drift: `tone="color"` + `[wide]="true"` is a vibe (its own fixed Tailwind gradient under bold white text, `w-40`), `tone="muted"` + `[wide]="false"` is a genre (flat `bg-theme-surface-2/70`, small `text-theme-secondary`, `w-[4.75rem]`) — recessive on purpose, so the genre index never competes with the vibes. The gradients are **fixed** colour pairs rather than `--theme-*` tokens: a theme-derived gradient collapses to grey under OLED and Daylight, erasing the contrast the two tones exist to create; white-on-gradient is legible on all six themes without a per-theme accent shadow. The vibe row is `grid grid-flow-col grid-rows-2` + `overflow-x-auto`, so it is a fixed two rows that scrolls sideways at every width instead of growing tall on a phone.

  The tile's `data-testid` sits on the **host** `<app-vibe-tile>`, not the inner `<button>` — a signal input can't carry it, because the JIT vitest harness never registers inputs on a nested component (`testing/signal-input.ts`, landmine 1) — and the host carries `class="inline-flex"` so it has a real layout box for a Playwright click. That same limitation is why the tone/width contract is pinned in `vibe-tile.component.spec.ts` (component as root) and `e2e/tests/radio-landing.spec.ts` (real build, now driving `/classic`), **not** in `radio-landing.component.spec.ts`, where every nested tile renders its defaults. `data-testid`s: `radio-landing`/`radio-resume`/`radio-resume-play`/`radio-preset`/`radio-genre`/`taste-breakers`/`taste-breakers-item`. → [docs/radio.md](../docs/radio.md)

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
  `<h1>`. Section headings _within_ a page (`text-lg` h2s like radio-landing's, and
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

- **`MenuPanelComponent` works as a _picker_, not just an action list.** The role control is a
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
users table, and registered in `nicotind/shared-helpers` so a second copy fails CI. The translator is
an **optional parameter** rather than an injected service: that keeps the module pure (testable as a
plain function, no Angular DI) and lets a surface that hasn't been through the i18n pass call it and
get the original English wording verbatim.

**Tier criteria** — pick one when adding a routed page, based on what the page _is_, not how wide it
happens to look today:

| Tier        | Pages                                                                                                                       | Why                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `max-w-6xl` | Library, album/artist/genre detail, Acquire, Downloads                                                                      | Browse surfaces — grids/lists that want the room. Downloads moved `max-w-5xl` → `6xl` to join this tier rather than keep a one-off width.                                                                                                                                                                                                                                |
| `max-w-3xl` | Playlist detail, Radio landing, Share view, Poll view, Admin, Settings, About, Devices, Agent tokens, Privacy, Recommendations, Extensions (`plugins.component`) | Reading/mixed surfaces — a mix of prose-width content and wider panels (Admin's tables/forms don't need browse-grid width). The settings-family started one tier narrower (`max-w-2xl`), but the 2xl/3xl split made the content column visibly jump when navigating Settings ↔ Admin ↔ Extensions — all `SettingsGroupComponent` pages now share this tier (issue #420). Privacy, Recommendations and the public poll page were the last on 2xl and moved here too (#1807). |

**Section idioms** — once inside a page, three shapes cover everything:

- **Grouped card** = `SettingsGroupComponent` (`components/settings-group/`). This is _the_ idiom
  for a collapsible titled block (Settings, Devices, Agent tokens, Extensions, and Admin all use
  it) — never a hand-rolled `rounded-xl border ...` card. It **owns its own `mb-6` bottom margin**
  on the root `<section>` rather than relying on a parent `space-y-6` wrapper. This is a deliberate
  choice, not an oversight: a parent `space-y-*` adds `margin-top` to _every_ child including
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
  that used to live _inside_ a `SettingsGroupComponent` body, plus its `space-y-12` root spacing)
  were stripped down to bare blocks — the outer grouped card already supplies the chrome, so an
  inner card was double framing; its service-status tiles moved from `bg-theme-surface` to the
  softer `bg-theme-surface/50` to read as content-inside-a-group rather than a second nested card.

A static, non-collapsible card idiom (tentatively `section-card`) was **deliberately not added** —
no page currently needs "a card, but never collapsible", so adding the utility ahead of a real
consumer would just be unused surface area. If one shows up, add it as a named `@utility` next to
the other three; never reintroduce a raw `rounded-xl border ...` literal as a one-off.

**Drift guard**: `packages/web/src/app/pages/page-shell.spec.ts` (runs in `bun run test:web`)
asserts, per a `PAGE_TIERS` table, that all 16 routed page templates contain their assigned
`page-shell max-w-<tier>` string, and separately bans the raw bare-surface card literal
(`rounded-xl border border-theme bg-theme-surface` without a `/`-opacity or `-2` suffix) and the raw
uppercase-heading literal on the six idiom pages (Settings, About, Devices, Agent tokens,
Extensions, Admin). `packages/e2e/tests/settings-consistency.spec.ts` is the runtime
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

### Rows never widen the page (#1807)

`<main data-scroll-root>` is `overflow-y-auto`, and a scrolling y axis turns `overflow-x: visible`
into `auto`, so one row wider than its card slides the **whole page** sideways on a phone instead of
clipping. The rows themselves follow these rules:

- **Two or more text buttons, chips or links wrap** (`flex flex-wrap`), or the row is an explicit
  `overflow-x-auto` strip. A _group_ of controls is never `shrink-0`; `shrink-0` is for one short
  control beside a `min-w-0` sibling. Size for the longest locale (es). A title that shares a
  wrapping row with buttons gets a floor (`min-w-[10rem]`) instead of `min-w-0`, so the buttons
  wrap below it rather than squeezing it to nothing.
- **A flex or grid item holding text, a nested row or a form control gets `min-w-0`.** An
  arbitrary grid track is `minmax(0,1fr)`, never a bare `1fr`.
- **Server or user text that can be long without spaces** (paths, URLs, ids, errors, `<code>`)
  carries `break-all` or `[overflow-wrap:anywhere]`.
- **A form control in a row takes the leftover space** (`flex-1 min-w-0`), never its intrinsic
  width.

`radio-poll.spec.ts` pins the reported case: an open poll's row in Spanish at 375 px.

**Every route is swept, not just the reported ones.** `horizontal-overflow.spec.ts` opens every
route — the library tabs, album/artist/genre/playlist/curate, both Get tabs, Settings and its
sub-pages, Admin, and the public poll, share and login pages — at 320, 360 and 390 px, in `en` and
`es`, with **every settings group expanded** (a collapsed group renders no body, so a card nobody
opened is a card nobody measured). Polls (one open, one closed), a playlist and a share link are
seeded so their rows exist. It asserts through `expectNoHorizontalOverflow` (`packages/e2e/helpers.ts`),
which every page-overflow check in the suite now shares: `html`, `body` and `<main>` must not scroll
sideways, and no element may cross the viewport's edge. A failure names the **outermost** offender,
skipping `position: fixed` layers and anything inside a container that owns its own overflow (a scroll
strip, a `section-flush` table, a `truncate` host). Chromium only: an iOS-only overflow is still a
device check. Its first run found three rows the code audit had not: the new-playlist form (an input
with no `min-w-0`), the Agent tokens scope `<select>` (as wide as its longest option) and the Stats
period strip in Spanish at 360 px.

**The guard is the backstop, not the fix.** Routed content sits inside a non-scrolling
`<div data-x-guard class="overflow-x-clip">`: one inside `<main>` around the shell's
`<router-outlet>`, and one in `app-root` around the root outlet for the pages outside the shell
(login, setup, the public poll and share pages scroll the document). `clip`, never `hidden`:
`overflow-x: hidden` is still a scroll container, so `focus()`, `scrollIntoView` or D-pad focus can
slide it sideways with no way back (the #1749 trap), while `clip` makes no scroll container at all,
so sticky descendants still stick to `<main>`. `clip` on `<main>` itself would not work: with
`overflow-y: auto` it computes to `hidden`. `position: fixed` layers (sheets, toasts, players) and the
mosaic's absolute stage have containing blocks outside the guard and are not clipped by it.
`expectNoHorizontalOverflow` switches every guard off before it measures, so the sweep still finds
the offender a user would no longer see; `horizontal-overflow.spec.ts` also plants a 2000 px row in
each guard and asserts that the page does not scroll.

**The template rules.** `src/horizontal-overflow-policy.spec.ts` parses every template (`.html` and
inline) with `@angular/compiler`'s `parseTemplate` and fails on the shapes that overflow once data is
longer or the locale wordier, which the sweep's fixture data may never render:

| Rule | Fails on |
| --- | --- |
| R1 | a flex row of ≥3 text buttons/links that cannot wrap, or a `shrink-0` group of ≥2 |
| R2 | an `<input>`/`<select>` in a flex row with no width and no `min-w-0` |
| R3 | a flex item (or an item of an arbitrary `grid-cols-[…]`) without `min-w-0` whose descendant truncates unbounded |
| R4 | a bare `1fr` in an arbitrary grid template (`minmax(auto,1fr)`), instead of `minmax(0,1fr)` |
| R5 | a `<table>` outside an `overflow-x-auto` frame, or a truncating cell without `table-fixed` or `max-w-0` |
| R6 | `whitespace-nowrap` that is not `truncate` and not inside a horizontal scroller |

Not a rule: `truncate` directly on a flex item, since its `overflow: hidden` already zeroes the
item's minimum. Built-in `grid-cols-N` tracks are `minmax(0,1fr)`, so their items are not R3
candidates. A site that is fine (a TV-only row, a count beside a flexible input) is listed in the
spec's `ALLOWED` table under a reason, one entry per site, and a fixed site's stale entry fails too.
The spec asserts its own denominator (≥120 templates, ≥400 flex rows). Landing it fixed every site it
found: twelve form controls given `min-w-0`, two `[auto_1fr]` grids, the genre radar's truncating
cell, the format ladder's table (now framed), the Stats genre-mode strip, and four rows that now wrap.

## Boot — player restore never autoplays

`PlayerService.restoreState()` (called from `provideAppInitializer` in `app.config.ts`) loads the last track/queue/history/currentTime from `nicotind_player_state` but **leaves `isPlaying` false, unconditionally**. The snapshot's `wasPlaying` field is still written (harmless, and compatible in both directions with an older bundle) but is ignored on read. The page never attempts a gesture-less `audio.play()` on load, so the user always presses play themselves.

Effect 1 (`PlayerComponent` track-load) honours this: its two `audio.play()` calls are gated on `untracked(() => player.isPlaying())` so a freshly loaded track sits paused (`audio.src` set, `restoredTime` still applied by `onDuration`). Effect 5 (play/pause sync) remains the single authoritative driver of starting/stopping playback in response to `isPlaying`.

**No "tap to resume" banner (removed).** A rejected `audio.play()` (browser autoplay policy, `NotAllowedError`) used to flip a `PlayerService.autoplayBlocked` signal and show a dedicated banner/button over the mini-player and the Now Playing sheet whose only job was to re-issue `audio.play()` from a real click. It was a vestige from before playback restore was paused-by-default (above) — the gesture-less resume path that used to make it common is gone, so it fired rarely, and its Now Playing sheet copy had rotted unnoticed: `unblockAutoplay()` there grabbed the wrong element via `document.querySelector('audio')` (the component always renders two `<audio>` elements and alternates which is active — see the dual-buffer gapless-swap comments on `PlayerComponent.audioEl`), so tapping it silently did nothing. `handlePlayRejection()` now just falls back to paused (`player.pause()`) while the screen is visible — the ordinary Play button is a fresh gesture and succeeds. The screen-locked case (`document.visibilityState === 'hidden'`) is unrelated and unchanged: it still queues a resume for when the app returns to the foreground.

**Removed: the opt-in resume.** There used to be a per-user `autoplay_on_load` preference — a `user_settings` column, a `POST /api/auth/autoplay` route, an `autoplayOnLoad` field on `/me`, `AuthService.setAutoplayOnLoad()`, `PlayerService.maybeResumeAutoplay()` and a Settings → Playback toggle — whose only effect when enabled was to make the app start playing audio on page load. Off was already the default and the better behaviour, so the whole path is gone; the column is left in place (nothing in this schema drops columns, and `config-export.ts` / `privacy.ts` read `user_settings` generically). Restoring the queue, track, shuffle/repeat/radio, context and seek position is unaffected — only the gesture-less `play()` disappeared. Guarded by `player.service.spec.ts` ("restore never resumes playback"), `settings.component.spec.ts` ("renders no autoplay-on-load toggle"), `player.component.spec.ts` ("loading while paused doesn't call play"), and `e2e/tests/player.spec.ts` ("reload leaves the player paused by default").

## The `/get` workspace — Acquire + Downloads merged

Acquire and Downloads were two top-level nav items for two halves of one job: _ask for music_ → _watch it arrive_. They are now one route, `/get`, with an internal `?tab=find|downloads`. This is the same defect issue #227 fixed, in reverse — there, one page was trying to be two things; here, one job was split across two pages. The test either way: **can a user state the page's one job in a sentence?**

### The shell, and why `@if` is load-bearing

`GetComponent` (`pages/get/`) is deliberately thin — ~60 lines owning the tab bar, the `?tab=` param, and the active-download badge. Its template is two branches mounting the **untouched** `SearchComponent` and `DownloadsComponent`. Neither child's TypeScript changed, so every `data-testid`, service injection and lifecycle hook survives.

The `@if` must never become `[hidden]`. `PullToRefreshService` is a **stack spliced on the registrant's destroy** (`services/pull-to-refresh.service.ts`), and both children register a handler — Search re-runs the query, Downloads calls `kickPoll()`. Destroying the inactive child is what unregisters its handler, so the pull gesture always refreshes the tab you're actually looking at. The same destroy also stops `SearchComponent`'s result poll and runs its `cleanupSearch(id)`. With `[hidden]` both leak, and the wrong handler wins (the stack returns the _last_ registered).

Downloads polling is unaffected by any of this: `TransferService.startPolling()/stopPolling()` are owned by `LayoutComponent`, app-shell-wide, not by the page.

## Polling stands down when nobody is looking

Every recurring client poll goes through one helper, `createVisibilityPoller` (`lib/visibility-poller.ts`). It owns its timer, consults `document.hidden`, and takes `delayMs()` as a _function_ so one loop can serve a cadence that changes at runtime.

| service                                                                      | visible                                                                                                                                                                                                                                                                                                                                                                                          | hidden                                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `TransferService`                                                            | 3 s while a job is in a live stage (resolving/queued/downloading/organizing/scanning — `jobKeepsFastCadence`, #806), 30 s idle; **10 s / 120 s while the library events stream is connected** (the stream carries the transitions, the poll is the safety net); a pushed `job.changed` kicks it only while it runs, so the TV, which opens the stream but never starts it, does not poll (#1666) | **paused**                                                                                                               |
| `LibraryEventsService` (not a poller: one SSE stream, `/api/library/events`) | open while visible                                                                                                                                                                                                                                                                                                                                                                               | closes 30 s after hiding, reopens from the last seq — [cache-invalidation.md](cache-invalidation.md) "Live invalidation" |
| `AcquireService`                                                             | 2 s (and it self-stops when no job is active)                                                                                                                                                                                                                                                                                                                                                    | **60 s**                                                                                                                 |
| `ServiceReviewService`                                                       | 5 s                                                                                                                                                                                                                                                                                                                                                                                              | paused                                                                                                                   |
| `DownloadReviewService`                                                      | 30 s                                                                                                                                                                                                                                                                                                                                                                                             | paused                                                                                                                   |

**Pause is the default; a slow cadence is the exception you justify.** A poller feeding only derived state — a badge, a count, the `libraryDirty` flag — can pause outright, because the catch-up poll on resume recomputes all of it. `AcquireService` is the one that cannot: it is where the "added to the library" toast fires, and a toast that waits for you to look at the tab is not a notification. So it drops to a heartbeat instead of stopping.

Two properties are load-bearing and easy to lose in a rewrite:

- **The delay is measured from completion, not dispatch.** A `setInterval` fires regardless of whether the previous round-trip finished, which stacks requests on a slow connection. The helper awaits `poll()` and _then_ schedules, so a slow poll can never queue a second one behind it.
- **A visibility flip re-arms immediately** rather than waiting out the timer armed under the old state. Going hidden 1 ms into a 3 s cycle must not still fire at the fast rate.

Why the helper exists at all: `TransferService` had no gate. Started app-wide by `LayoutComponent` and stopped only on destroy, it polled two endpoints every 30 s from every backgrounded tab, sleeping phone and idle TV, forever. Measured on the public edge, `/api/downloads/jobs` and `/api/acquire/jobs` were **~75% of all traffic reaching nginx**, with a flat overnight floor of ~873 req/h — roughly 7 idle clients polling through the night with nobody awake to read the result. `ServiceReviewService` and `DownloadReviewService` had each grown their own byte-identical copy of the gate; the fix (#717) extracted the one copy and put all four on it. It is registered in `SHARED_HELPERS`, so copy #5 fails CI.

### Tab state is in the URL, unlike Library's

Library keeps its tab in `localStorage`; `/get` keeps its tab in the URL. The difference is intentional — "show me my downloads" has to be linkable, and `/downloads` redirects onto it. `?tab=` is user-editable, so `parseGetTab` treats anything unrecognized (including `'DOWNLOADS'`) as the `add` default rather than rendering a blank pane. The legacy `find`/`downloads` stay parsed for bookmarks, but the app's own links write `add`/`activity` (#1544).

A search's results live on the root `SearchService`, which outlives the tab, so switching Add → Activity → Add restores the Results _and_ the album cards (`SearchService.catalog`, #1544). A new search clears them with `resetResults()`. `reset()` is the logout wipe: it also drops the search history, the per-file download marks and the persisted folder marks. Calling it per search emptied all three on every query (#1563).

### Redirects need a _function_ `redirectTo`

`/search`, `/acquire` and `/downloads` all still resolve. A string `redirectTo` can only **preserve** incoming query params, never **add** one — but `/downloads` has to arrive with `tab=downloads`. Angular's `RedirectFunction` (`(PartialMatchRouteSnapshot) => string | UrlTree`) runs in an injection context, so `redirectToGetTab` in `app.routes.ts` injects the `Router` and builds the UrlTree itself, merging `queryParams` with the tab. That's what keeps a bookmarked `/search?q=…` landing on its query.

### Gating, and the nav going to four

`acquireGuard` now covers the whole merged route. Previously `/downloads` was hard-guarded while `/acquire` only soft-gated itself with an in-template empty state — an asymmetry a merged route can't keep. A listener (or an `NICOTIND_ACQUISITION=off` deployment) simply never sees the nav item, which retires `search-acquisition-off` as a reachable state; the block stays in the template, since it's still correct if the component is ever mounted for a non-acquirer.

Nav is now **Home · Library · Add · Settings** (the route is `/get`; the label is `nav.get` → "Add"). Two fixes rode along:

- The mobile bar's column count is **derived** (`gridColumns()` → `repeat(N, minmax(0,1fr))`) instead of a hardcoded `grid-cols-5`. The old value was already wrong for listeners, who saw 4 tabs in a 5-column grid with a dead trailing column.
- The mobile badge now counts in-flight URL acquisitions, matching the desktop formula. They had silently disagreed: a spotdl/yt-dlp job showed a count on desktop and nothing on a phone.

`/get` is deliberately **not** in `ONLINE_ONLY_ROUTES` even though its Find tab needs the network — the Downloads tab never was, and gating the whole item would hide the download feed offline. The app-shell offline banner carries that message.

## Library tab bar and toolbars — one row each on a phone

On a 390 px phone the Library spent three rows before the first song: an eight-tab pill that had
to be dragged sideways, and a toolbar (`search · sort · Filters · Select · count`) that wrapped to
two lines. Both are one row now, at every width down to 360 px.

**Tabs are icons; only the active one is labelled.** `LibraryComponent.modes` carries an `icon`
per tab — Songs `music`, Albums `disc-album` (a record in its sleeve), Compilations `layers`,
Singles & EPs `disc` (the bare record), Artists `mic-vocal`, Genre `tag`, Playlists `list-music`,
Stats `chart`. On a phone the bar is full width: inactive tabs are `flex-1 min-w-8` and share the
row, the active one is `flex-initial min-w-0` and its label truncates rather than wrap if a long
translation ("Recopilaciones") would not fit. From `sm` up every tab is content-sized again. An
inactive tab's label is not removed but `sr-only`, so every button keeps its accessible name and
its text — the e2e `getByRole('button', { name: 'Songs' })` locators and the i18n spec's
`toContainText` both read it — plus a `title` for a pointer's tooltip; the active tab carries
`aria-current`. The home's _Shelves | Mosaic_ switch is the second adopter (#1667, see "Home view
switch").

**Songs is first, and it is the default.** `DEFAULT_LIBRARY_MODE` (`'songs'`) is what a device
with no `nicotind-library-mode` opens on; a persisted tab still wins. Because Albums is no longer
what most visits land on, it became lazy like the other tabs: `ngOnInit` fetches the album grid
only when Albums is the tab on screen, otherwise it marks it stale and `setMode('albums')` loads
it on the first switch. The e2e seed user keeps Albums as its last tab (docs/e2e.md).

**The toolbar is two shared controls plus icons.** `SearchFieldComponent` is the search box: its
host is `flex-1 min-w-0`, so it takes whatever the icons leave, and the result count (the Albums
`library-album-count`, the other tabs' "N matches") sits inside the field as a trailing `hint`
rather than beside it. `SortSelectComponent` is the sort control reduced to one 36 px icon: a
native `<select>` laid transparently over the sort glyph, so a phone still opens its own picker
and Playwright's `selectOption` / `toHaveValue` keep working on the same `data-testid`; it takes
an optional `direction` and renders the existing direction toggle beside it. Filters is the
shared panel with `compact`, an icon trigger whose active count rides the corner (see
docs/library-filters.md). Select on the Songs tab is a `check-square` icon button. Every
icon-only control takes its `aria-label` and `title` from the same catalog key, so the Spanish UI
no longer names them in English. The row is `flex items-center gap-2`, never `flex-wrap`.

The JIT unit harness does not bind a nested component's signal inputs, so the page specs cannot
see inside the two controls; each has its own spec, the page specs pin the tab bar, and
`mobile-ux.spec.ts` measures both rows in Spanish at 360 px with every tab active in turn.

## Library find bar — cross-type, not per-tab

One box above the Library tabs searching everything you own at once: **Albums, Artists, Songs**, grouped by type, in `LibraryFindComponent` (its own file — `library.component.ts` is already 759 lines across 7 tabs).

A non-empty query **replaces** the tab content rather than filtering the active tab. That's the whole point. `feedback-log-2026-07` item #7 was a user whose album row was clean and whose tracks were all present, but who concluded the release was missing because no album _card_ ever surfaced — they were looking at the wrong result type. A filter scoped to the active tab reproduces that failure by construction; a cross-type result set is what closes it. The e2e case asserts exactly that: an artist+title query surfaces an **album card**.

Mechanically:

- `browseMode()` is `computed(() => find() ? null : libraryMode())`. The seven tab-content blocks switched from `libraryMode() === …` to `browseMode() === …`; the tab _bar_ still reads `libraryMode()`, so the user's tab stays visibly selected underneath and clearing the box returns them to it. This avoided re-indenting ~480 lines of template to wrap it all in one conditional.
- Typing is debounced 250 ms into `find`, mirrored to `?find=` with `replaceUrl` so a search is linkable and survives reload without spamming history. `libraryMode` is never written by the find bar.
- No matching of its own. `/api/search`'s local lane (`LibrarySearchProvider`) already tokenizes, NFD-folds diacritics, ANDs per token over a `name+artist` haystack, — it is precisely the matcher the #7 fix installed.
- A monotonic `generation` counter discards a slow response for a query the user has already typed past, and stops it clearing a spinner the newer request owns.
- A failed request renders `library-find-error`, **not** the empty state. Collapsing the two would tell a user they don't own music they do own.

Deliberately out of scope: **playlists** (the local lane returns `{artists, albums, songs}` only — adding them is an API change), and any **acquisition handoff** from the results. Library is a listening surface; the bridge to `/get` is the nav item. The Songs-tab search box stays as a within-tab filter.

The one handoff is the **empty state** (#1663): when nothing matches, an acquirer (`auth.canAcquire()`) gets a **Get it** button (`library-find-get`) that writes the query into `SearchService.query` and opens `/get?tab=add` — **prefilled, never searched**, the same "the user presses Enter" rule as a pasted link. When the query differs from the one already there it first calls `SearchService.resetResults()`: the service is a root singleton that keeps results across navigation (#1544), and another query's cards under the new box would fetch something other than what it reads. A listener sees only the empty message.

The bar is a **primary field** (#1663): the shared `input-lg` utility (`styles.css`) gives it a 48px height and a 16px font — the size below which iOS Safari zooms the page on focus — with a 20px icon and a 40px clear button. The per-tab filters (`app-search-field`) stay compact `h-9` secondary controls. `library.spec.ts` measures both floors at 375px.

Offline the bar is hidden (`findAvailable()`), since the local lane is unreachable and the page falls back to on-device preserved tracks.

## One album grid per artist tab (the discography is not a second list)

The artist page used to render the same albums **twice**: the tab grid showed the
library, then a separate "Full Discography" section repeated every release from
MusicBrainz with its own covers, status badges and `Complete Album` / `Find Album`
buttons. For Pink Floyd that was ~18 local tiles followed by 17 near-identical ones,
and answering "do I have all of this album?" meant reading a cover twice and
cross-referencing two grids.

Now each tab renders **one** ordered set of tiles, newest first, with the gaps in
place. `buildArtistAlbumTiles` (`lib/artist-album-tiles.ts`) is the pure join;
`AlbumTileComponent` renders one tile in one of three states:

| State                          | Looks like                                                      | Offers                                                      |
| ------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------- |
| `owned`                        | exactly what it always did                                      | nothing — the grid stays quiet where there is nothing to do |
| `partial`                      | a normal, clickable, playable tile with a `4/7 tracks` subtitle | `Complete album`                                            |
| `missing`                      | dimmed, dashed border, **does not navigate**                    | `Get album`                                                 |
| `missing`, with a local folder | a normal, clickable tile, no count                              | `Get album`                                                 |

A partial album is deliberately **not** dimmed. You own those four tracks and they
play; dimming it would say otherwise. The action buttons are gated on
`auth.canAcquire()` — before this, a listener was shown a button whose route
answers 403.

**The join key is the server's `localAlbumId`.** `DiscographyService` already matches
each release to a local album with `normalizeForGrouping`, and threads the result
onto the wire; the web reads it and never re-derives it. That is a rule, not a
convenience: `nicotind/shared-helpers` registers the `normalizeTitle`/`fold` family
precisely because three separate ASCII-only copies shipped as three separate bugs
(#662, #706, #715). **The visible consequence is that when the server's match misses,
one album renders twice — once owned, once missing.** That is today's behaviour made
visible rather than a new defect (the two grids simply kept it far apart), and a spec
pins it so it cannot be mistaken for an accident. The real fix is the single
album-identity resolver deferred in [album-hunt.md](album-hunt.md).

**Track counts match titles without featuring credits (#1565).** Inside a matched album,
`localTrackCount` counts the release's tracklist titles found among the local songs. A file
tag's "Felt (feat. Henry Green)" never equalled Lidarr's "Felt", so prod's _A Life_ (one
local song then) read **0/11** while owned. The server's `trackKey` drops the credit
(`stripFeaturingSuffix`) before `normalizeTitle`. A tile prints its "n/N tracks" only when
at least one track matched.

**One tile per title and type.** Lidarr can list several albums under one title: prod's
Ed Sheeran page drew four identical "÷ (Deluxe)" tiles, each with its own Get, though the
Get's in-flight guard treats them as one album. `collapseSameTitledReleases` keeps one
entry per title (case and accents folded) and album type: the one the library matches
best, then the one with a tracklist. Editions keep their own tile. What the four Lidarr
rows are (separate release groups or metadata duplicates) was not inspected.

**A tile never offers a Get the server would refuse.** The title match and the Get's
guard are different rules: `albumAlreadyComplete` counts the local album's songs against
the tracklist's length, so a song under a spelling the title match misses still counts
there. Prod's _Epigram_ held all 35 songs, 21 of them titled with the featuring credit
before the remix name; the tile read **14/35** with a "Complete album" button, and every
click answered "You already have". `buildDiscographyAlbum` now grades such an album
`present` through `artistAlbumAlreadyComplete`, the same count keyed on the local artist id.

**One completeness rule, for the header and every tile (#1627).** The tab bar's
`n releases · n complete · n partial · n missing` and each tile's state both read
`albumCompleteness` — the server's tracklist match (`DiscographyAlbum.status`), never
the mere existence of a local album. The tile used to draw any matched album that was
not `present` as partial, so on prod's La Vela Puerca page — two folders each holding
one song from the _other_ album's tracklist — the header said `0 partial · 9 missing`
while both tiles offered `Complete album`. A local folder that holds none of its
release's tracklist is now `missing`, as the header counts it, and offers `Get album`;
it keeps its link and its menu, because the songs in it are still yours.
`summarizeDiscography` is the header's half.

**A tile re-reads once its job lands (#1627).** The tile's label is the completeness
read when the page loaded, so after Downloading → Organizing it fell back to its
pre-click label until a reload. The page watches `TransferService.acquisitionJobs`
— the feed `job.changed` on the library event stream re-polls — for the live jobs
fetching one of its releases (`releaseJobsInFlight`: by Lidarr id, or by `sameAlbum`,
the same two ways a tile finds its hunt status). When one leaves `active`, it
re-reads the artist's albums and discography in place, both at once: no reset, no
spinner, no polling of its own. Until that re-read lands, the releases the ended job
was fetching report `LANDING_HUNT` (busy, "Scanning"), not `idle` — the hunt service
drops a job the moment it leaves `active`, and the discography read (Lidarr plus a
track fetch per release) takes seconds, a window in which the pre-job button was live
again and a click drew a 409 `already-complete`.

**The missing tail is filtered, the library never is.** A release we do _not_ own
whose `secondaryTypes` include Live / Compilation / Remix / Demo / Soundtrack /
Mixtape / DJ-mix, or whose `albumType` is not Album/EP/Single, sits behind a
`Show all N more releases` toggle — otherwise a prolific artist's grid becomes 60+
tiles of broadcasts and reissues. An album **already in the library always renders**,
whatever Lidarr calls it: nothing you own can be filtered out of view.

Two smaller rules worth knowing:

- **An owned tile stays in the tab its _local_ row is in.** The caller passes
  `albums()` or `singlesAndEps()`, so Lidarr calling something an EP never moves a
  tile out from under the user. A release whose match lives in the other tab is
  skipped rather than drawn as missing — otherwise you would get a "you don't have
  this" tile for an album you own.
- **`visibleTabs()` counts merged tiles, not local rows.** Counting local rows hid
  the Albums tab for an artist whose every album is missing — exactly the case the
  acquire buttons exist for.

The discography arrives seconds after the local albums (it can provision the artist
in Lidarr). Local tiles render immediately and missing ones slot in; while it loads
the tab bar carries a one-line `Checking full discography…` rather than a skeleton
grid, because eight placeholder tiles next to real content read as content.

**The summary is a sibling of the tablist, never inside it (#1636).** It used to share
the tablist's flex row, so on a 390px phone it squeezed into a 4-line block beside the
tabs and wrapped `Singles & EPs` onto two lines. Now the row (`artist-tab-row`) holds the
tablist (`artist-tablist`, tabs only) and the summary as siblings: below `md` the summary
takes its own line under the tabs; from `md` it sits inline, right-aligned, wrapping
inside its own box rather than pushing the tabs. Labels are `whitespace-nowrap`, and a
phone too narrow for all four tabs (a 360px Android in Spanish) scrolls the strip instead
of wrapping a label or the page. Because a scrolling box clips, the phone strip draws its
rule as an inset shadow and the tabs drop the `-mb-px` overlap they use from `md` up. Every
label in the row, the toggle, the empty slates and the tile's `Get album` /
`Complete album` / `n/N tracks` go through the catalog (`artist.tab.*`,
`discography.summary`, `albumTile.*`). `artist-tab-row.spec.ts` measures the four-tab
Spanish row at 390px, and at 1280px pins the summary inline and right-aligned on the tabs' row.

**Testing note.** `AlbumTileComponent` takes `input<AlbumTile>(EMPTY_TILE)`, not
`input.required()`. The JIT vitest harness does not register signal inputs on a
_nested_ component, so a required input throws NG0950 during the **host's** change
detection and takes the host's whole spec down — see `src/testing/signal-input.ts`.
For the same reason `artist-detail.component.spec.ts` asserts the merged grid at the
model level and leaves the tile's DOM to `album-tile.component.spec.ts`, where the
tile is the root component.

## Genre chips are the editor (issue #684)

The track-info sheet has always _rendered_ a song's full genre set as chips, primary
first — but for a curator they were read-only. The only write was "Check genre" →
Apply, and it had a display bug that made the feature read backwards: the route
**appends**, while the component set `genreOverride` to just the applied genre, so the
sheet redrew as if the whole set had been wiped. Every write now adopts the server's
returned `genres` array instead of guessing, which is also why `applyGenre` returns it.

The chips now carry the three missing gestures, curator-gated (`canCurate()`):

- **Add** — a `+ Add` chip opens an inline input (Enter commits, Escape cancels) and
  sends `mode: 'append'`, the route's own default. A simple add creates no override.
- **Remove** — an `×` on each chip sends the _remaining_ set as `mode: 'replace'`.
- **Reorder** — native HTML5 drag between chips (the `now-playing-queue-panel` pattern,
  no CDK/Sortable dependency), sending the reordered set as `mode: 'replace'`. Position
  0 is the primary genre, so dragging a chip to the front _is_ "make this the primary".

**Why removal and reorder are `replace` and adding is not**: append can only add, so
"exactly this set, in this order" is unexpressible through it. `replace` writes a
song-scoped `library_genre_overrides` row, which is also what makes a deliberate
curator ordering survive the next rescan — the right durability for an explicit edit,
and the wrong one to impose on a one-genre add.

The last remaining chip has no `×`: the route requires at least one genre and there is
no clear-genre endpoint for songs (unlike `DELETE /artists/:id/genre`). Drag is also
suppressed at one chip, where it means nothing.

The reorder splice moved into the shared pure `lib/move-in-list.ts`, now used by both
this and `PlayerService.moveInQueue` — a second drag-reorder surface is the point where
two identical splice pairs start drifting.

## A failed tag mirror is surfaced to the curator (issues #885, #856)

Both `PUT /songs/:id/bpm` and `POST /songs/:id/genre` have always returned
`tagWritten: boolean | null` (`true`/`false` = the write was attempted and succeeded or
failed; `null` = never attempted — no `musicDir`, or the file is missing). The web app
used to drop the field on the floor: `chooseBpm()` and `writeGenres()` (both in
`track-info-sheet.component.ts`) adopted the new value and moved on, so a curator who
picked a BPM octave or edited a genre chip had no way to learn the file's own tag
mirror never actually landed.

Both call sites now run their response through the shared private
`warnIfTagMirrorFailed(tagWritten)`, which toasts (`ToastService`, `kind: 'error'`)
exactly when `tagWritten === false` — never on `true`, and never on `null` (nothing
attempted is nothing to act on). The wording is deliberately not "failed": the DB
write (or, for a genre `mode: 'replace'` call, the song-scoped
`library_genre_overrides` row — see [genre-model.md](genre-model.md) `#762`) already
landed and remains the durability mechanism today, so the curation itself is not lost.
What the toast says is narrower and true: the file's own copy did not update, so the
change may not survive a future file replacement — for a `replace`-mode genre write
specifically, that replacement also re-mints the song id the override is keyed on,
which is the highest-stakes instance of this failure (the _re-pointing_ of that
orphaned override is a separate, not-yet-built fix — issue #856's other half).

`applyGenre`'s response type on `LibraryApiService` was missing `tagWritten` entirely
(so nothing could have read it even if a caller tried); `setSongBpm`'s already carried
it. Both are typed with it now, so a future caller cannot silently drop it the way
`applyGenre`'s did.

## Retagging a track from the drawer (issue #724)

Issue #722 shipped the whole retag mechanism — `PATCH /api/library/songs/:id/metadata`
(curator-gated, delegating to the tested `mutateSongMetadata`), the song-scoped
`GET /api/library/songs/:id/metadata-candidates` gatherer, and the MCP
`fix_song_metadata` tool — and no web affordance at all. So the one role the ladder
promises curation to could rename a polluted YouTube-sourced track only through an MCP
agent or `normalize-titles.ts`; from the app, not at all.

The drawer's `@if (canCurate())` **Tags** section closes that. Collapsed it is a
read-only summary (title / artist / album artist / album / year — the header carries
only the first and second); **Edit tags** opens the same rows as inputs,
prefilled from `effectiveSong()` so an edit is a correction rather than a blank slate.

Two things are deliberate about what it sends and what it says:

- **Only what changed.** `tagChanges()` diffs the draft against the current row and
  sends nothing else. The route writes every field present in the body, and each write
  re-mints the name-derived album id — an untouched field re-sent is a needless tag
  rewrite. An empty or whitespace-only field is dropped, matching the route's own
  add/replace-never-clear guard (`buildIdentifyApplyTags`).
- **A write that could not be confirmed is said out loud.** `verified: false` means the
  tags reached the file but nothing read them back, so the library still shows the old
  values; it toasts, in the same shape as `warnIfTagMirrorFailed`. A rejection carries
  `requested` vs what the row `actual`ly holds (issue #776) and the form renders that
  divergence instead of a bare "could not save" — and stays open, so the edit is not
  thrown away.

**Find matches** is one call feeding two halves: the offline `suggested` title from
`cleanDisplayTitle` (a one-tap chip) and the online candidate releases, each a tappable
row that fills album / album artist / year. Both only _fill the draft_ — the curator
still saves. The route's `q` and `fingerprint` options are not surfaced: nothing drives
a query override yet, and the drawer's own Identify button already owns fingerprinting,
which costs a 20 s AcoustID round-trip.

Client: `LibraryApiService.getSongMetadataCandidates` / `fixSongMetadata` (which
invalidates the cached library reads, since a retag re-buckets artists and albums).

## Queue semantics — what a click replaces (issue #233)

A track click used to call the bare `PlayerService.play(track)`, which sets `currentTrack` + `isPlaying` and **never touches `queue`**. So clicking one track left whatever was queued before in place, and `playNext()` pulled that unrelated queue as soon as the deliberately-clicked track ended. The fix is not "always clear the queue" — that would wipe the queue on every album-track click too. It's making the _gesture_ decide, via three explicit entry points:

| Method                            | Queue effect                                                            | Used by                                                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `play(track)`                     | untouched — **primitive**                                               | only queue-owning callers (`playWithContext`, `playNext`, `jumpToQueueIndex`) and `RemotePlaybackService` state sync, which must not mutate local queue state |
| `playSingle(track)`               | replaced (queue + history emptied, `context` nulled)                    | a context-less click, and `startRadio(track)`                                                                                                                 |
| `playWithContext(tracks, i, ctx)` | replaced by _that list_ from `i`                                        | every row click inside a list                                                                                                                                 |
| `jumpToQueueIndex(i)`             | consumes `[0..i]`; skipped entries + the outgoing track go to `history` | the Now Playing "Next up" row tap                                                                                                                             |

A row click in a list is always `playWithContext` — the list becomes the queue. Two surfaces were still on the bare primitive and are fixed: **album detail** (`playSong` now resolves the clicked song's index within `albumTracks()` and plays from there with an `album` context; falls back to `playSingle` if the song isn't in the album's track list) and **genre detail** (`playSong` plays from the clicked index through `filteredGenreSongs()`). `now-playing.jumpToTrack` moved from `play()` — which left the tapped entry _in_ the queue, so it replayed the moment it ended — to `jumpToQueueIndex`.

`startRadio(track)` clears the queue too, and anchors the session on that track: a leftover queue played out in full before the radio the user asked for ever started. `playSingle` and `playWithContext` clear the anchor (a gesture re-anchors; a radio advance never does). `toggleRadio`'s eager fill covers the now-empty queue. `startRadioWithFilter` already set its own queue and is unchanged.

Guarded by `player.service.spec.ts` (`playSingle` / `playWithContext` / `jumpToQueueIndex` / `startRadio` describe blocks).

## A stale chunk reloads; an offline one does not (issue #872)

Two things go wrong when a lazy route chunk fails to arrive, and until #872 the
app answered both the same way.

**A stale chunk reloads.** A tab left open across a deploy asks for a hash that
no longer exists; `lazy()` (`lib/stale-chunk.ts`) reloads once to pull the
current build. That path is unchanged — see
[deployment.md](deployment.md) "A missing asset 404s; a stale build reloads
itself" for why the honest 404 is what makes it recognisable.

**An offline chunk must not.** `isStaleChunkError` matches the browser's wording
for a failed dynamic import, and an _offline_ import throws that same wording —
so it answers "did the import fail?" while being read as "is the build stale?".
The window is real, not theoretical: `ngsw-worker`'s `install` only calls
`skipWaiting()`, and `activate` claims clients without `waitUntil`-ing the
prefetch it kicks off — so the worker takes control of the page with an empty
cache. Take the network away inside that window and it can neither serve the
chunk nor fetch it: `Driver.safeFetch` synthesises a `504 Gateway Timeout`
rather than rejecting, and a module `import()` of a 504 rejects with exactly the
stale-chunk wording.
Reloading there is strictly worse than the dead tap it replaced: `index.html`
sits in the _same_ prefetch asset group as the chunk, so if the chunk was
uncached the shell almost certainly is too, and the reload lands on the
browser's offline error page — a running app destroyed by its own recovery.

So `recoverStaleChunk(reload, store, online)` declines while offline. The
connectivity check runs **before** the `sessionStorage` marker, so the offline
decline does not spend the one-reload budget the same tab will want when it is
back online and hits a genuinely stale build. `online` is a parameter defaulting
to `navigator.onLine` rather than an injected `NetworkStatusService`, to keep
`lazy()` a pure route-config helper — the router _does_ invoke a loader inside
`runInInjectionContext`, so injecting would be legal; it is a scope choice, not
a constraint. The service worker is disabled in native shells
(`serviceWorkerEnabled = !devMode && !nativeShell`), so the unreliable
Android-WebView `navigator.onLine` never reaches this path. The gap that leaves
is wifi-with-no-internet, where `navigator.onLine` stays `true` and the reload
still fires — one wasted reload, marker spent, no loop. Pinned by
`stale-chunk.spec.ts`.

**A route load in flight now says so.** There was no navigation state anywhere —
`NavigationStart` had zero subscribers and both router outlets were bare — so a
slow (or never-arriving) chunk looked identical to a tap that did nothing.
`LayoutComponent` folds `NavigationStart` / `NavigationEnd` / `NavigationCancel`
/ `NavigationError` into a `navigating` signal with a delayed
`navigatingVisible` (250 ms, the same no-flash rule as `bufferingVisible`
below), rendered as a thin accent bar at the top of `<main>`
(`data-testid="route-progress"`). It is decorative (`aria-hidden`) — the page it
announces is the announcement — and it is deliberately not translated, since it
carries no text. `NavigationSkipped` needs no handling: the router emits it
_instead of_ `NavigationStart`, never after one.

**Known gap:** the bar lives in `layout.component.html`, so it only covers
in-shell routes. `/login`, `/pair` and `/server` render through `app.ts`'s bare
`<router-outlet />` and still show nothing while their chunk loads.

## Playback loading feedback (HDD-aware loaders)

> This section is about **spinners** — feedback for an action already in flight.
> For the placeholders that stand in for _not-yet-arrived list content_, see
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
  silently register `bufferingVisible` as a dependency of the _calling_ effect
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
  **Second line = entity links**: the row's `artists` credits and its `album`
  input (`AlbumRef { id?, name }`, built by `albumRef(song)` in
  `lib/track-utils.ts`) render as `EntityLinkComponent`
  (`components/entity-link/`, selector `app-entity-link`, inputs `kind`
  `album|artist|genre|playlist`, `id`, `name`, output `followed`) — an
  `<a routerLink appTvNavItem data-testid="entity-link-<kind>">` whose click
  stops propagation so it never plays the row; `subtitle` stays for plain text
  and reads "Artist · Album · subtitle" (`data-testid="track-row-subtitle"`).
  The link degrades to a `<span>` when the id is missing (offline metadata) or
  when `kind === 'artist'` on TV (`isTvBuild() || isTvUi()` — the TV route tree
  has no artist route; the `isTvUi` half is so the e2e TV lane, which stamps the
  class on the prod bundle, renders what a real TV renders). `ArtistLinksComponent`
  renders its segments through the same component, so every artist name gains
  the D-pad nav-item and the TV span rule at once. Hosts that overlay the page
  (Now Playing: `queue-row`/`queue-row-title`, `now-playing-album`; the
  track-info sheet) close themselves on `followed`; the Now Playing album line is
  omitted on TV to keep the pinned root-group ArrowUp order. The queue row is a
  `div` with the title as the jump `<button>` — an anchor may not sit inside a
  button. Nested inputs and outputs do not land in the JIT unit harness, so the
  rendered href / no-play / close-on-follow contracts live in
  `e2e/tests/entity-links.spec.ts`.
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
this.bufferingVisible()) return`) _read_ `bufferingVisible` while running
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
    arrives, the recovery gives up waiting, **reloads the source**
    (`audio.load()`) and plays, so a truly-corrupt file doesn't strand the
    user on a frozen track. It reloads rather than seeking to 0 because after
    a stream cut short mid-transfer the browser's media cache still holds the
    truncated resource — a bare seek + play replayed the same few seconds
    without requesting a single new byte, ended early again, and burned the
    whole recovery allowance without ever giving the network a second chance.
  - The seek bar's `safeProgress` no longer falls back to `t` when the
    duration is unknown — it stays at 0 — so the user does not see a
    100 %-filled bar during recovery (the "seek bar at 100 %" part of the
    symptom).
  - A `loadGeneration` counter (bumped on every resource change, captured at
    listener bind time) is a defense-in-depth filter against stale events that
    could otherwise leak into queue handling — see "Every `src` change bumps
    the load generation" below.
  - The 5 s valve **resumes where the listener was**, not at 0. `startRecovery`
    captures `restoredTime ?? audio.currentTime` when it arms, and the valve
    writes it back to `restoredTime` before `audio.load()`, which `onDuration`
    replays once a sane duration lands. Without this, every valve fire threw
    away everything before the fault — a recovery three minutes into a track
    restarted it from the beginning, which is the visible half of the
    "I seek forward and the track starts over" report.

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
make `onEnded` _refuse_ to advance on a false `ended` — but nothing capped how many times it could
refuse. `onEnded` re-entered `startRecovery` on every false `ended`, and the 5 s valve resets
`recoveryState` to `'normal'` and then reloads + plays. So a resource that is _genuinely_ short
(a truly truncated cache file, not a mis-parse) ends early again, is flagged false-ended again, and
restarts every ~5 s — **forever, never reaching the next queue item**. The `startRecovery`
early-return on `'awaiting-duration'` doesn't help: the valve has already cleared that state. The
guard that was meant to stop a premature advance had become a guard against _ever_ advancing.

Fixed with a per-load attempt bound: `MAX_RECOVERY_ATTEMPTS` (3), counted in `recoveryAttempts`,
incremented inside `startRecovery`. Once the allowance is spent, `onEnded` falls through to the
normal advance path and the resource is treated as legitimately short — a corrupt file costs ~15 s
rather than stalling the session. The counter resets when a **new resource** takes over, not when a
recovery succeeds, so the same element can't refresh its own allowance indefinitely.

Found alongside it: both recovery-exit sites assigned `this.recoveryTimeout = null` **without**
`clearTimeout`, which only forgets the handle — the armed 5 s valve still fired after a _successful_
recovery and ran the reload fallback, yanking the listener back to the start of the track. The
two sites now share one `clearRecoveryTimeout()` helper (also used by `startRecovery` and
`ngOnDestroy`), so the handle has a single teardown path. The two bugs compound: the stray restart
can itself provoke another early `ended`, feeding the loop the bound is there to stop.

**The recovery state outlived the track it described.** Everything above is per-resource, but only
some of it was _reset_ per resource, and the two halves of that omission produced the two halves of
one user report: a track skipped to "loads for a second, reloads, then either sits silent or skips
itself on its own".

- `recoveryState` lives on `PlayerService`; `recoveryAttempts`, `retryOnReconnect` and
  `recoveringStream` are component fields. The track-change effect reset the three fields and not the
  signal. Every exit from `'awaiting-duration'` — `onDuration`, `onCanPlay`, the 5 s valve — is gated
  on the `loadGeneration` captured at bind time, and a track change bumps that generation. So
  pressing Next _during_ a recovery (what a listener does when a track is visibly stuck) left the
  signal set with no live path back to `'normal'`. Recovery then depended entirely on the _next_
  track loading cleanly — and when it did not, `startRecovery` hit its own
  `'awaiting-duration'` early-return and did nothing at all: no recovery, no advance, a silent
  player. `armStallWatchdog` stands down on the same signal, so the fallback for a stream that
  stalls without raising `error` was wedged too.
- The reset also sat _below_ the `lastManualSrc` early-return, which `onEnded` takes when it
  pre-loads the next track itself. A natural advance therefore handed the incoming track the spent
  allowance of the one that had just failed, and its own first false `ended` fell straight through
  to the advance path — the track skipping itself, and then the next, down the queue.

Both are now voided together in the existing "a genuine track change" block, keyed on
`loadedTrackId` and above the pre-load return, alongside the pending seek that dies on the same
terms. Keying on the id rather than "the effect ran" is what keeps a token refresh from refreshing a
flaky resource's allowance — the property the paragraph above claims and the old placement did not
actually hold on the natural-advance path. Regression cover: the
`a track change interrupts an armed recovery` block (state cleared, the new track able to arm a
valve of its own, the abandoned valve not reloading its replacement, the stall watchdog live again,
and a naturally-advanced track getting a fresh allowance).

**Truncated preserved blob — the "plays 3-4 s, feels cached" variant.** A user report of playback
delivering only ~3-4 s per track, the buffered band instantly full at those few seconds, then a
stall or an advance — on _every_ play of the affected tracks. That signature (instantly-buffered,
short, identical each time) is a preserved/auto-preserved IndexedDB blob, not the stream: a `fetch`
cut short by a proxy or network drop can **resolve** with a partial body instead of rejecting (an
intermediary that ends the stream cleanly — e.g. an HTTP/2 reverse proxy losing its backend — looks
like a normal EOF to the browser), and `PreserveService.fetchTrackBlobs` stored whatever arrived.
Because the store is durable, one bad fetch poisoned the track long after the network recovered,
and the false-ended recovery above made it _worse_ there: every retry replayed the very same bytes.
Defended at both ends:

- **Store-time gate** (`preservedAudioLooksComplete`, `preserve.service.ts`): an audio body is
  rejected before it reaches IndexedDB when it is empty or its byte count disagrees with the
  response's own `Content-Length`. A missing/unreadable header skips the comparison (older server,
  CORS) rather than rejecting healthy fetches.
- **Play-time self-heal** (`recoverFromTruncatedBlob`, `player.component.ts`): a false `ended`
  while the element is sourced from a `blob:` URL of a preserved track means the stored copy itself
  is short — waiting or retrying can never help. When online, the poisoned preservation is removed
  and the element is re-pointed at the network stream, honoring the play intent; offline (the blob
  is the only source there is) it falls back to the bounded blind recovery. Heals count against the
  same `MAX_RECOVERY_ATTEMPTS` allowance so a truncated stream after the swap stays bounded.

Regression coverage: `preserve.service.spec.ts` `store-time truncation gate` +
`preservedAudioLooksComplete` blocks; `player.component.spec.ts`
`false ended while sourced from a preserved blob (truncated store)` block (heal path, offline
fallback, allowance exhaustion, stream-sourced false endeds leaving the preservation alone).

## A stream that dies is reloaded, not abandoned

**The bug.** "The music just stops." A transfer that dies mid-track — a socket the network dropped,
a connection the WebView could not re-open while a page's request burst held the ones it had, a
server that blinked — reached the app in one of two shapes, and _neither_ was handled:

1. **`error`.** The handler cleared the buffering flag and returned. Nothing retried. The store
   still said `isPlaying`, so the mini-player kept showing a pause button over silence, the seek bar
   sat frozen, and only a manual press brought the track back.
2. **Nothing at all.** The element parks on `waiting`/`stalled` and never asks for another byte.
   That path raised no event the player acted on, so it was the same dead end without even an error
   to look at afterwards.

Mobile is where this actually bites: a phone changing cells, or a page firing a burst of requests
against the handful of connections a browser keeps per origin, is an everyday event on Android and
a rarity on a desktop talking to localhost — which is why it reads as "playback stops when I open
_this_ page" rather than as a network fault.

**The fix** (`recoverFromDeadStream`, `player.component.ts`), reached from `error` and from the
stall watchdog alike:

- **Reload and resume.** After `MEDIA_ERROR_RETRY_MS` (retrying in the same tick would only re-run
  into whatever is still busy) the element is re-pointed at the same track and the position is
  handed to `player.restoredTime`, so the listener lands where the stream died rather than at 0 —
  the same restore mechanism the vocal-mute toggle uses.
- **The stall watchdog** (`armStallWatchdog`, `STREAM_STALL_TIMEOUT_MS`). Armed by
  `waiting`/`stalled`/`seeking`, disarmed by the first byte that moves the clock (`playing`/`canplay`/
  `timeupdate`), so it only ever fires for a load that made no progress for the whole window. The
  threshold sits far above a slow first load — an HDD spin-up plus a server-side transcode is
  seconds, not tens of seconds — and it stands down while a seek is still _held as an intent_ or the
  false-ended valve is in flight, since both own the element's silence and resolve on their own
  bounded clocks. A seek already committed to the element is **not** exempt: the held intent's
  valve is dropped on commit, so before this a committed seek whose bytes never arrived had no
  bound at all (see "A far seek that stalls" below).
- **The failure's own `pause` is suppressed** (`recoveringStream`, `holdPausedState`). A fatal media
  error pauses the element, and `onPause` would commit that to the store 250 ms later — before the
  reload runs, and against an intent the listener never withdrew. The first version of this fix
  stood down for exactly that reason: the retry fired, found `isPlaying` already false, and did
  nothing.
- **Offline holds the intent instead of dropping the track** (`retryOnReconnect` + the reconnect
  effect). The bytes are not coming back until the network is, so no retry is spent against a dead
  radio and nothing is torn down; the reconnect effect resumes it. It reads the monotonic
  `reconnects` counter as well as `online` for the reason `NetworkStatusService` documents — signals
  coalesce, so a fast offline→online pair (a tunnel, a lift, a cell handover) is invisible in
  `online` alone, and that pair is precisely this case.
- **Bounded, and honest when the bound is reached.** Retries count against the same
  `MAX_RECOVERY_ATTEMPTS` allowance as the false-ended flow (one budget per resource, reset when a
  new one loads). When it is spent the player _pauses for real_ and toasts
  `player.streamInterrupted`: a paused player the user can restart is honest, a "playing" one with
  no sound is not.
- **A parked element is not a dead stream** (`parkedGeneration`). `teardownAudio` assigns `src = ''`,
  which raises `error` on the element. Recovering from that would re-point it at audio the app just
  decided to stop — and, offline, would re-enter `stopForOffline` forever.

Regression coverage: `player.component.spec.ts` `dead-stream recovery` block (reload-and-resume,
paused intent, allowance exhaustion, watchdog fire, slow-but-alive load, offline hold + reconnect
resume, parked element); `packages/e2e/tests/playback.spec.ts` aborts a real stream request in
Chromium — it is the browser's own media pipeline that has to raise the error for this wiring to be
worth anything.

## Seeking past the loaded region

**The bug.** Drag the seek bar forward on a track that has not finished
loading and the track froze for five seconds, then restarted from the
beginning. Two mechanisms compounded:

1. The seek bar is enabled the moment a track becomes current — Effect 1 sets
   the duration from API metadata before a single byte has moved — while
   `onSeek` poked `audio.currentTime` directly. Assigning a position past what
   the browser holds does **not** fail: the element clamps to the end of its
   seekable region and fires `ended`.
2. Downstream, that `ended` is indistinguishable from a track finishing. It
   landed in `isFalseEnded` (position far short of the API-known duration),
   which paused playback for the 5 s recovery valve — and the valve then called
   `audio.load()`, resetting the timeline to 0. The machinery built to rescue
   corrupt streams was destroying a perfectly ordinary seek.

**A seek is an intent, not a poke.** `PlayerService.pendingSeek` holds
`{ trackId, time }` — the position the user asked for, keyed by track so a skip
during the wait voids it. The flow:

- Every seek funnels through `player.seekTo` and Effect 6, which is the single
  place a request becomes a media-element operation. `onSeek` (the seek bar)
  now calls `player.seek()` rather than touching the element, so the bar and the
  OS media-session handlers share one applier and one gate. Remote-device seeks
  still short-circuit to a WS `SEEK` command.
- `requestSeek` clamps the target to the known duration (the bar cannot exceed
  it, an OS `seekto` can), records the intent, arms the valve, and tries once.
- `applyPendingSeek` assigns `currentTime` **only** when `seekTargetReachable`
  says the element can satisfy it: the target sits inside an `audio.seekable`
  range with `SEEK_AVAILABILITY_EPSILON_SEC` to spare, _or_ the seekable region
  already reaches the end of the track (a fully-seekable resource cannot clamp,
  so a deliberate drag to the last second is a seek to the end, not something to
  sit and wait on). Otherwise the intent is held and buffering stays up. It is
  re-tried on every signal the region may have grown: `durationchange`/
  `loadedmetadata`, `progress` and `canplay`.
- The seek bar reads the target while the intent is held (`displayTime` prefers
  `pendingSeek` over `currentTime`), so the bar sits where the user dropped it
  instead of snapping back to the old position.
- `PENDING_SEEK_TIMEOUT_MS` (10 s) is the valve, and it is not optional: some
  resources never report a range covering the target (a transcode the server
  never finishes, a file shorter than its tags claim). It lands the user as far
  forward as the element can actually go and drops the intent — a bounded
  disappointment rather than a spinner that never resolves.

The pure range logic lives in `lib/seek-availability.ts`
(`timeRangesToArray` / `seekableEnd` / `seekTargetIsAvailable`), DI-free and
free of `TimeRanges` in value positions because jsdom cannot construct one.

**Defense in depth.** If a resource's `seekable` over-promises and `ended`
fires anyway, `onEnded` moves the outstanding target into `restoredTime` before
handing off to `startRecovery`, so the reload resumes at the seek target rather
than 0. A genuine end clears the intent instead of letting it leak onto the
next track.

Regression coverage: `player.component.spec.ts` `seek past the loaded region`
block (immediate apply inside the region, held intent past it, the bar showing
the target, apply-on-growth via both `progress` and `durationchange`, the
clamped-`ended` case not advancing the queue, the valve resuming at the target,
the timeout landing at the reachable edge, a skip voiding the intent, a token
refresh _not_ voiding it, and remote-device forwarding). Plus
`seek-availability.spec.ts` for the pure helpers.

### A far seek that stalls (iOS)

**The report.** On an iPhone, a seek past the loaded region left the player
under a spinner with no sound, and only tapping play brought it back.

**Why the intent machinery above never saw it.** The server answers Range
requests for every stream, transcodes included, so iOS reports the whole file
as `seekable` from the first byte. `seekTargetReachable` is therefore true for
any target, and the seek is committed to the element at once — the held-intent
path, and its valve, never run on iOS. What follows is up to the engine, and
two gaps met there:

1. **WebKit pauses the element itself when its platform player stalls.** The
   `pause` it raises looks like any other to `onPause`, which committed it to
   the store 250 ms later. The spinner stayed up (the seek was still loading),
   the store said paused, and nothing resumes a paused player — until the tap,
   which is just a `play()`.
2. **The stall watchdog stood down for `audio.seeking`**, on the assumption
   that the pending-seek valve owned the silence. It does only while the seek is
   held; once committed the intent and its valve are gone. So a committed seek
   that never landed was bounded by nothing.

**The fix.** `onPause` asks `isStarved(audio)` first: a seek in flight, or a
buffering episode the element reported (`buffering` with `readyState` below
`HAVE_FUTURE_DATA`). A pause raised while starved, with `isPlaying` still set,
is the engine giving up on a stall rather than a listener asking for silence:
the intent is kept, `play()` is re-issued **once** (`starvedReplayed`, cleared by
`playing` or a new resource, so an engine that keeps pausing cannot loop us),
and the stall watchdog is armed. The watchdog now stands down only for a seek
still _held_ as an intent, and `seeking` arms it as well (not every engine
follows a seek into missing data with `waiting`). A seek that never lands is
reloaded after `STREAM_STALL_TIMEOUT_MS` at the target — `recoverFromDeadStream`
reads `currentTime`, which already holds it mid-seek.

**Two pauses are deliberately left alone.** `isStarved` is never true at the
end of a track (`audio.ended`): `pause` fires just before `ended`, and a
`play()` there would restart the track. And a pause while the element is at
rest still commits, so a user's pause from outside the app (headphones, an OS
control) works as before. The narrow cost: an OS pause that lands in the middle
of a stall is overridden once.

Regression coverage: `player.component.spec.ts` `a far seek that stalls` block —
the starved pause kept as playing with one `play()`, no loop on repeated
pauses, a fresh replay after bytes flow, the reload at the target when the
seek never lands, a pause at rest still committing, no replay at `ended`, and a
held intent still left to its own valve.

## Rapid track changes — a skip burst costs one load

Five quick Next presses used to fire five stream requests and abort four. On an
HDD library each aborted request can spin the disk and start server-side
transcode work, and the audio element was asked to begin and abandon four loads
in a row while four `play()` promises raced. The result felt broken: audio
stuttering in and out, the spinner flickering, the wrong track occasionally
winning.

**Navigation and loading are now separate concerns.** Effect 1 still applies
every press instantly — `currentTrack`, title, artwork, duration, buffering
flag and the row indicators all land on every change, so nothing looks frozen.
Only the byte-level load is gated by `LOAD_SETTLE_MS` (250 ms):

- **Leading edge** — the first change after a quiet period commits
  immediately, so a single Next has exactly today's latency. This is why the
  window is not a plain trailing debounce: paying 250 ms on every ordinary
  track start to fix a burst would be a bad trade.
- **Trailing edge** — a change arriving inside the window cancels the pending
  commit (via the effect's `onCleanup`) and re-arms. The outgoing element is
  paused for the duration, through `pausingByStore` so `onPause` does not
  commit a store-level pause. A five-press burst therefore costs the leading
  load plus one for wherever the user actually landed.

The natural-end path is deliberately **not** debounced: `onEnded` pre-loads the
next track synchronously (to keep the Android audio session alive) and marks it
via `lastManualSrc`, which returns before the gate. Gapless playback is
unaffected.

**`loadDeferred` is why Effect 5 needs a guard.** Effect 5 syncs the element to
`isPlaying`, and during the settle window the element still holds the
_outgoing_ resource — so an unguarded `play()` there audibly resumes the track
the user just skipped away from. The flag is cleared at the top of every
Effect 1 run and set only by the deferring branch, so it can never outlive the
window it describes; the deferred commit's `playIfIntended` owns starting the
incoming track. Reachable whenever `isPlaying` goes false→true inside the
window (paused, then a skip).

**Every `src` change bumps the load generation.** It used to be bumped only on
the cross-element standby swap, reasoning that the browser discards queued
events when `src` is reassigned on the same element. That covers _events_ but
not the `play()` promises already in flight, and a skip burst produces a pile
of them. `assignSource(audio, src)` is now the only way the component points an
element at a resource: it bumps `loadGeneration`, re-binds the listeners (they
compare against the value captured at bind time, so bumping _without_
re-binding would silence the element permanently), then assigns. `playIfIntended`
is the matching play helper — it starts playback only when `isPlaying` is set
and ignores the `AbortError` a superseded load produces.

Regression coverage: `player.component.spec.ts` `rapid track changes` block —
a single change loading immediately, five changes collapsing to two loads with
the final track winning, store state staying current while the load is
deferred, a settled burst loading immediately again, and a handler from a
superseded load being inert (invoked directly, since dispatching on the element
would reach the new listeners and prove nothing).

**A committed load reuses the standby (#1301).** Only `onEnded` used to swap to
the pre-buffered standby; a manual Next inside the 30 s window threw it away and
started a cold request. `commit()` now checks `standbyHolds(trackId)` — the
standby's track id **and** the exact src it was pointed at (`preloadedSrc`), so a
vocal-mute toggle or token change since the preload falls back to a cold load —
and calls the same `swapToStandby()` `onEnded` uses. The swap flips `audioEl`,
which re-runs Effect 1; `lastManualSrc` makes that re-run return early, as it
does for the natural advance. Covered by the `manual Next reuses the pre-buffered
standby` spec block.

**A dead standby is never reused (#1726).** Nothing listens on the standby, so a
pre-load that failed (a 503 for a just-landed track, a dropped socket) went
unnoticed. Swapping to it played nothing, and its `error` had already fired, so
no recovery ran: the new title showed while the player sat "buffering" for good.
A track under 30 s pre-buffers the next one at once, so this hit as soon as a
short track was playing. `standbyAlive()` (no `error` on the element) gates both
`standbyHolds()` for a committed load and `onEnded`'s natural advance; a dead
standby falls through to a fresh load on the active element, which has the
normal media-error retry. Covered by unit specs in both blocks and by the e2e
`stream-error-stale-audio.spec.ts`, which 503s the pre-load in a real browser.

**Still not in scope:** the standby pre-loads only in the last 30 s of playback,
so a skip earlier in a track is a cold load. Extending the preload to the queue
head at all times would make every single Next near-instant; it needs
invalidation on every queue-head change, which is a larger change.

## iOS background advance

iPhone listeners on the web app (Safari or a home-screen PWA) heard the current
track to its end whenever the app was not on screen — the phone locked, _or_
unlocked with another app in front — and then silence: the queue never
advanced until they came back. With the app open it advanced fine.
Auto-preserve (above) had already taken the network out of the picture, so
this was not the "a backgrounded page gets no responses" limitation — it was
two WebKit rules for a hidden page that the advance broke.

1. **A hidden page may keep its playing element, not start another.** The
   gapless path swaps to the standby element at `ended` and calls `play()` on
   it. In the foreground iOS allows that; with the page hidden it refuses
   `play()` on an element that was not already the one playing. `onEnded`
   then only queues a resume for when the page is visible again — hence
   "advances fine while I'm looking at it".
2. **A hidden page is suspended once it goes silent.** Once `ended` fires
   nothing is playing, and iOS suspends the backgrounded page's process soon
   after. The preserved-track advance read the blob out of IndexedDB _between_
   `ended` and `play()` — an async round trip the suspension can land in the
   middle of. With auto-preserve on, that is the path nearly every advance
   takes.

Locked and "switched to another app" are the same state to the page
(`document.visibilityState === 'hidden'`), which is why both fail and why one
fix covers both.

**The fixes, one per rule.** On iOS WebKit (`isAppleMobileWebKit`, which counts
iPadOS's Mac-looking UA by its touch points) the player runs single-element:
`prepareNext` never buffers into the standby, so `standbyHolds` is never true,
and both the natural advance and a manual Next re-point the element that is
already playing (`assignSource` + `play()` in the same `ended` task, like the
cold path on every other platform). The cost is a short gap between tracks on
iOS while the next stream's first bytes arrive. Everywhere else the standby
swap is unchanged. On every platform, when the queue head is preserved, the
last 30 s now read its blob ahead (`prepareNextBlob`) and hold an object URL,
so `onEnded` hands it over through `takeNextBlobUrl` and calls `play()`
synchronously. The read happens once per track, is revoked when the queue head
changes or the player is destroyed, and when it has not landed by `ended` (a
track under 30 s, a slow store) the old read-at-`ended` path still runs.

**What this does not fix.** A stream that is _not_ preserved still needs the
network after `ended`; that is auto-preserve's job, and why it exists. And an
iOS lock-screen Next while a burst is settling still pays `LOAD_SETTLE_MS` on
a timer the OS may throttle — single presses commit on the leading edge.

Regression coverage: `player.component.spec.ts` `background advance` block —
iOS never touching the standby and advancing on the playing element (visible
and hidden), the gapless swap kept elsewhere, a preserved next track playing
in the same task as `ended` with no second read, one read across many
`timeupdate`s, revocation on a queue-head change, and the fallback when the
read-ahead has not landed.

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

The harness is on vitest 5 + jsdom 30. `@angular/build` 22.1 peers `vitest ^4`, so `bun.lock` also
carries a nested `vitest@4` under it; nothing runs it, because only `ng test` would. It dedupes once
`@angular/build` reaches 22.2, whose peer range admits `^5`. Vitest 5 turns `clearMocks` on by
default: a mock's call history is wiped before every test, so assert calls made in `beforeAll` or at
module scope inside that same hook, not in a later test.

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
gates and only surfaced at `ng build` — the _last_ step of the CI `ci` job, after lint and every
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
a silent **no-op** in this harness — with _and_ without a following
`detectChanges()`, the input keeps its default and every downstream `computed()`
reads the default. It does not throw, which is what makes it dangerous: a spec
written that way passes _vacuously_. Re-run that check before re-litigating; if
a future `@analogjs/vite-plugin-angular` registers inputs properly, the helper
can be deleted outright in favour of the supported API.

Three rules, all documented on the helper itself:

- **Never `input.required<T>()` on a component intended to be nested.** The
  harness doesn't register signal inputs on a _nested imported_ component, so
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
  after it can silently check the _first_ value.
- **To assert on a _reaction_ to an input change, use `changeInputValue`.** It
  goes through `signalSetFn`, so the version bumps and consumers are marked
  dirty — the next `detectChanges()` runs an input-driven `effect()` exactly as
  a real parent binding would. `setInputValue` cannot test this by
  construction: it is the seed-before-first-`detectChanges()` call, and its
  whole point is bypassing the notification. A spec written with the wrong one
  does not fail loudly; it passes against the value it never changed.

This exercises the real production template/CSS — it only swaps out _how_ the
input value gets in.

## Now Playing waveform + karaoke VFX (issue #643)

Two visual surfaces fed by one precomputed artifact, `GET /api/peaks/:id` → `WaveformData`
(`@nicotind/core` `types/waveform.ts`): a ≤600-pair min/max envelope and a 4 fps six-band energy
timeline (sub-bass … high, 0..1 relative to the track's loudest frame-band).

**Why precomputed, and not a live analyser.** `player.component.ts` documents the prohibition:
routing the `<audio>` element through `MediaElementAudioSourceNode` silenced playback on Android.
There are also _two_ `<audio>` elements that swap for gapless playback, so a one-time
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
Every filesystem call on the `/peaks` path is async — the source check, the cache stat and read,
the artifact write — so a cache hit never blocks the event loop the audio streams share (#1328). A
test fails if a `*Sync(` call reappears in the store or the handler. The corrupt-artifact delete runs
only when a file is actually there, since a missing one may be a concurrent decode's about to land.

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
Queue/Lyrics panel down, on every cold track _and_ on every skip (`loadWaveform` clears the signal
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
`cancelAnimationFrame` on cleanup; while paused a
single frame is painted. The playhead between `timeupdate`s is extrapolated on the wall clock and
re-anchored on every update. A null 2D context (jsdom, headless) is a no-op frame, never a throw.
`lib/vfx-scene.ts` is the one place to change the look — the component only paints shapes.

**Fetch lifecycle.** The shell (`now-playing.component.ts`) fetches `getPeaks` lazily, like lyrics:
only while the sheet is open and the track changed, **and only once `player.buffering()` has cleared**
(#1328) — a cold peaks request is a full server-side ffmpeg decode that competed with the stream for
the disk at time-to-first-audio, and a skip burst started one per track; now a burst fetches only the
track it lands on. A late-response guard still keeps a slow decode for a track you've already skipped
past from painting over the current one. Plain `HttpClient` JSON —
`ngsw-bypass` is only for media Range requests.

## List loading skeletons

Every list view that fetches data renders a **shape-matched skeleton** while it
waits, via one `SkeletonComponent` (`components/skeleton/`). Before this, all of
them rendered the same copy-pasted spinner —
`border-2 border-theme border-t-zinc-300 rounded-full animate-spin` — centred in
`text-center py-20` dead space as a _sibling_ of the grid it stood in for. That
string appeared twelve times across seven templates, and a 5-column poster wall
resolved out of an empty page, so the layout jumped hard on arrival.

### The split rule (why some spinners stayed)

> A **spinner** means an action the user started is in progress.
> A **skeleton** means content is coming and its shape is already known.

Applied honestly, that leaves a lot of spinners in place. The ones deliberately
**not** migrated, and why:

| Site                                                     | Why it stays a spinner                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin.component.html:1`                                 | Not a spinner at all — a `<p>{{ 'admin.loadingUsers' \| t }}</p>`. It also stands in for a whole _settings page_ (five group cards, metric pills, a log viewer, three tables), not a list. **A `<div>` row stack cannot match a `<table>`'s auto-layout column widths**, so a table skeleton would jump — which is why there is no `table-row` variant. |
| `search.component.html` `resolvingAlbum()` overlay       | An action on one specific card.                                                                                                                                                                                                                                                                                                                         |
| `search.component.html` peer/track counter               | Live progress with an incrementing count — reporting, not placeholding.                                                                                                                                                                                                                                                                                 |
| `album-hunt-modal` (searching, "Queuing downloads…")     | Process reporting with a per-query phase list.                                                                                                                                                                                                                                                                                                          |
| `downloads.component.html:14`, `admin.component.html:69` | Scan-in-progress icons next to a live song count.                                                                                                                                                                                                                                                                                                       |
| `artist-image-menu`, `folder-browser`                    | Upload / fetch in flight.                                                                                                                                                                                                                                                                                                                               |
| `song-picker` "Searching…"                               | Debounced typeahead — a skeleton would strobe on every keystroke.                                                                                                                                                                                                                                                                                       |
| `playlist-detail` proposals                              | That section legitimately renders _nothing_ when there are no proposals; a skeleton would promise content that often isn't coming.                                                                                                                                                                                                                      |
| `radio-landing` vibe presets                             | Per-button in-progress. Its genre chips have no loading state and keep none: `@if (genres().length > 0)` means absent-not-empty, and there is no `currentTrack`-style proxy to tell "will be non-empty" from "will stay empty".                                                                                                                         |
| `track-row`, `player-*`, `now-playing-*`, `layout`       | Buffering, pull-to-refresh and the route-load bar — these encode _state_ in their motion.                                                                                                                                                                                                                                                               |
| `library.component.html` `.animate-loading-bar`          | Already not a spinner, and it reads "fetching more".                                                                                                                                                                                                                                                                                                    |

`pages/page-shell.spec.ts` guards the migrated set against regrowth and carries
that exclusion list inline, so it can be audited rather than just trusted.

### Variants

Each variant owns **both** its container classes and its item markup, so
shape-matching is a property of the component rather than of the caller. A
primitive that call sites assembled into grids would recreate the copy-paste as
a dozen hand-built placeholder blocks drifting from the lists they mirror.

**The host element _is_ the container** — `<app-skeleton>` carries the grid/stack
classes itself and drops into the same DOM position as the real list container,
with no wrapper div. Consequence: every variant's class string must begin with an
explicit display class, because an unknown element is `inline` by default and a
stacked variant would silently lose its vertical rhythm. There is a spec for it.

| variant         | container                                                             | default count | mirrors                                            |
| --------------- | --------------------------------------------------------------------- | ------------- | -------------------------------------------------- |
| `album-tile`    | `grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4` | 10            | Albums / Singles / Compilations, discography, find |
| `artist-tile`   | same 5-col grid                                                       | 10            | Artists tab                                        |
| `genre-tile`    | `grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3`                | 8             | Genres tab                                         |
| `track-row`     | `block space-y-0.5`                                                   | 8             | every song listing                                 |
| `shelf-tile`    | `flex gap-3 overflow-x-auto pb-2 -mx-1 px-1`                          | 6             | Recently played                                    |
| `detail-header` | `flex flex-col sm:flex-row items-center sm:items-end gap-6 mb-8`      | 1             | album / playlist / share                           |
| `artist-header` | `flex items-center gap-5 mb-8`                                        | 1             | artist page                                        |
| `mosaic`        | `block absolute inset-0 overflow-hidden`                              | 12            | mosaic home                                        |

`mosaic` is the one variant with no list to mirror: its "list" is a free canvas,
so it scatters squares from a fixed table (`mosaicSkeletonSpot` — deterministic
for the same reason `skeletonBarWidth` is) where the packed field will appear,
percent-positioned with a clamped width so one table serves phone and desktop.

Inputs: `variant`, `count` (clamped 1..60; header variants ignore it), `label`,
`containerClass` (replaces the default wholesale — search's catalog grid is a
narrower column scale than the library's, and is the one call site that needs
it), `trackCover` (mirrors `TrackRowComponent.showCover`; the album page passes
`false`), `testId`. **No input is `input.required`** — a required input on a
nested component throws `NG0950` under the JIT vitest harness and takes down the
_host page's_ whole spec (see `src/testing/signal-input.ts`), and this renders
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
   that _decelerates into_ both extremes and so dwells at the trough — it reads
   as a flash. `ease-in-out` sweeps through the minimum, so at the same nominal
   amplitude it reads as a breath.
2. One selector must own colour, animation and the reduced-motion opt-out
   together, or a call site can render a themed block and forget the animation.
3. The block colour has to be a theme token anyway, so a CSS rule exists either
   way.
4. One place to retune amplitude app-wide.

`.skeleton-block-soft` mixes toward the page background for secondary lines, so a
tile reads as a hierarchy rather than a solid slab.

**Caveat:** these rules are _unlayered_ (matching `.animate-loading-bar` and
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

**Reduced motion.** This is the app's _first_ `prefers-reduced-motion` rule, and
it is scoped to skeletons rather than a blanket `* { animation: none }` on
purpose: the buffering spinner, `.eq-bars` and `.animate-loading-bar` all encode
state in their motion, so freezing them destroys information. A skeleton's motion
is decorative — the shape already says "loading". The eink theme freezes it too,
because e-paper ghosts on repaint.

### Accessibility

The whole contract is the pure `skeletonAria(label)`:

| `label`         | host attributes                                             |
| --------------- | ----------------------------------------------------------- |
| non-empty       | `role="status"`, `aria-busy="true"`, `aria-label="<label>"` |
| empty (default) | `aria-hidden="true"`                                        |

The two are mutually exclusive by construction — a hidden live region is a
contradiction, and there is a spec asserting they never co-occur.

Why this survives `a11y:storybook:strict` at zero: placeholder blocks contain
**no text nodes**, so `color-contrast` never applies. That is the reason the name
comes from `aria-label` rather than an `.sr-only` string — a clipped text node is
exactly what axe reports as a contrast _incomplete_, and the strict gate is
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

## Names are never unreadably truncated (#1665)

A name the layout cuts to `Muriendo De Envidia F…` must still be readable in
full. `truncate` alone hides the rest for good on touch: there is no hover, and
`title=` tooltips do not exist on iOS or Android. A name that fits (`I am 34`)
stays plain static text.

**The primitive** is `OverflowRevealDirective` (`[appOverflowReveal]`), put on
the element that already carries `truncate`; the controller is the plain class
`OverflowReveal` in `lib/overflow-reveal.ts`. When `scrollWidth > clientWidth`
it animates the host's **own `scrollLeft`**. Nothing is cloned or wrapped, so
nothing reflows, a screen reader reads the one text node once, and
`translate="no"` stays wherever it was. The ellipsis shows at rest. While the
text is off its start, `.overflow-reveal-active` clips instead, so the ellipsis
does not cover the text being revealed. A pass rests `REVEAL_PAUSE_MS`
(1.5 s), scrolls at a constant `REVEAL_SPEED_PX_S` (40 px/s, so a long name
takes longer rather than blurring), holds, and returns at
`REVEAL_RETURN_SPEED_PX_S`. RTL names scroll the other way. An overflowing name
also gets its full text as `title`, unless the host already has a title.

**When it moves** (owner decision on #1665):

| Where                                                                                                                           | Trigger                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The playing title: Now Playing sheet, mini player, TV player, karaoke overlay, share-page player (`appOverflowReveal="always"`) | loops while on screen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Every other name, touch                                                                                                         | one pass once the row is ≥95% in view and has not moved for `REVEAL_SETTLE_MS`; again only after it leaves view and comes back                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Every other name, desktop (`(hover: hover) and (pointer: fine)`)                                                                | while the row is hovered or `:focus-visible`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Every other name, TV (`isTvUi()`)                                                                                               | while the row has D-pad focus; never on its own                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `prefers-reduced-motion: reduce`                                                                                                | never moves. On touch and TV the first tap on an overflowing name wraps it (`.overflow-reveal-expanded`) and does not reach the row, even when the name is itself the link or button (the listener is capture-phase). Later taps are the row's again. The wrap stays until the name leaves the screen entirely or its text changes: growing taller at a viewport edge does not undo it, or that tap would loop forever. A mouse click is never taken, because a pointer already has the `title` tooltip. A tap on a link inside the name is never taken |

"The row" is the nearest link, button, focusable, `li` or `tr` above the host.
An IntersectionObserver keeps a name that is off screen idle, so a list of 100
rows never runs 100 animations. A ResizeObserver stops it when the name starts
to fit. A MutationObserver resets it to the start when the text changes (a
track change).

**The guard** is `src/overflow-reveal-policy.spec.ts`, which runs in
`web-test`. It reads every `.html` and `.ts` template and finds each element
truncated by `truncate`, `text-ellipsis` or `line-clamp-*`, or by a stylesheet
class that sets `text-overflow: ellipsis` or `-webkit-line-clamp` (`styles.css`
for every template, a component's own stylesheet for its own template only).
Each one must carry `appOverflowReveal` or appear on `NOT_A_NAME`: error and
status messages, secrets and URLs, fixed UI copy and count lines, admin
diagnostics, the search input, and the artist bio's clamp with its own "Show
more". Markup built as a string, where no directive can attach, carries the
marker `data-overflow-reveal` (`REVEAL_MARKER_ATTR`) instead, and the spec
checks that every component writing it also calls `attachOverflowReveals`, or
the marker would be inert. It also refuses the reveal on a multi-line clamp
(`line-clamp-*`, or a stylesheet class setting `-webkit-line-clamp`): that text
wraps rather than overflowing sideways, so the reveal would never move. The list has one entry per site, so a
new truncation in an allowlisted file is a new site. A TS class string bound
with `[class]` is checked at its binding (`CLASS_STRINGS`). The spec also checks
that every component using the attribute imports the directive. Without the
import, the attribute is silently inert. It asserts its own denominator, so a
broken scanner cannot pass by finding nothing. The real layout is covered by
`e2e/tests/overflow-reveal.spec.ts`: touch once, the playing title always,
reduced-motion tap-to-wrap, and desktop hover, on a list row and on a mosaic
tile.

**The home mosaic (#1707)** builds its faces as HTML strings on pooled
elements, so it attaches the plain controller itself: its title and subtitle
carry `.mosaic-name` (one line, ellipsis) and the marker, and the frame that
finds the field at rest calls `attachOverflowReveals` on every face in the lens
that has none yet, with the tile element as the row (hover on the tile). The
title used to be a two-line clamp; it is one line now, because a clamp cannot
scroll. See the mosaic section for why the attach waits for rest.

**Adding a name**: put `appOverflowReveal` on the truncated element and
`OverflowRevealDirective` in the component's `imports`. A flex child still needs
`min-w-0` (or `truncate`'s own `overflow: hidden`) before it can overflow at
all. **Adding a truncation that is not a name**: add its file to the matching
`NOT_A_NAME` group, with a reason if no group fits.

## Changelog Modal

Clicking the version string in the **desktop header** (`layout.component`, `data-testid="version-changelog"`) or the **Settings page footer** (`settings.component`, `data-testid="version-changelog-settings"`) opens a scrollable modal showing the project's release history — versions, dates, and commit links from `CHANGELOG.md`.

- **Component**: `packages/web/src/app/components/changelog-modal/changelog-modal.component.ts` — hand-rolled modal (same overlay/ESC/backdrop-dismiss pattern as `confirm-dialog`), pre-computes parsed items on init.
- **Item parser**: `packages/web/src/app/lib/changelog.ts` (`parseChangelogItem`) — pure, unit-tested function that splits a `commit-and-tag-version` bullet into `{ scope?, description, commitSha?, commitUrl? }`. The scope (`**scope:**`) is rendered in bold; the commit SHA is a clickable external link.
- **Data source**: `packages/web/public/changelog.json` — a build artifact generated by `packages/web/scripts/build-changelog.ts`, which parses `CHANGELOG.md` (the `commit-and-tag-version` output: `## [version] (date)` → `### Section` → `* item` bullets) into the JSON shape consumed by the modal. **Capped at 50 versions** (newest-first); raw dates preserved as-is (`2026-07-02`).
- **Build wiring**: `prebuild`/`pretest` scripts in `packages/web/package.json` run the generator before every `ng build`/`test`. The modal imports the file as a **static ES module**
  (`import changelog from '../../../../public/changelog.json'`), so `tsc --build`/`typecheck:template`/vitest's transform all need it present on disk _before_ they run — and none of those three has a
  generation hook of its own, unlike `build`/`test`. That means the file **must stay checked in** despite being a generated artifact: a `.gitignore` entry for it (`packages/web/public/changelog.json`)
  had existed since some earlier commit but was inert (the file was already tracked when the entry was added, and `.gitignore` never untracks an already-tracked file) — the entry has been removed now
  that this is understood, so the repo state matches what the ignore rule always silently failed to achieve. `build-changelog.ts` writes only when its output actually differs from what's already on disk
  (`writeIfChanged`), so a no-op regeneration (the common case — `CHANGELOG.md` hasn't moved since the file was last committed) never dirties the git working tree.
- **Docker build context (gotcha)**: because the generator reads repo-root `CHANGELOG.md` at build time, the file **must reach the Docker build context**. `.dockerignore` excludes all `*.md`, so it carries an explicit `!CHANGELOG.md` un-ignore, and the `web-builder` stage `COPY CHANGELOG.md ./` before `bun run build`. Miss either and `build-changelog.ts` silently writes `[]` (`existsSync` fallback), so the modal opens **empty in the browser webapp** while the locally-built Capacitor app (full repo present) still works. Guarded by `packages/web/src/app/lib/docker-changelog-context.spec.ts`, which emulates the `.dockerignore` filtering + asserts the `COPY`. (Fixed after the initial changelog-modal ship; the first Docker fix only silenced the crash, not the empty output.)
- **Stale `CHANGELOG.md` in dev**: `CHANGELOG.md` only updates on `bun run release` (CI release job). Between releases the embedded JSON reflects the last release's changelog; the `package.json` version (shown as `v{version}`) advances independently via the release commit. This is the same build-time-bake pattern as `APP_VERSION` (which imports `package.json` at build time).
- **API version**: `GET /api/system/status` `nicotind.version` is read from `package.json` at server startup (`src/main.ts` → `createApp({ version: pkg.version })` → `systemRoutes`), replacing the previous hardcoded `'0.1.0'`.
- **GitHub Release description (second `CHANGELOG.md` consumer)**: the `release-notes` job in `.github/workflows/deploy.yml` (`if: github.ref_type == 'tag'`) `awk`-extracts the tag's `## [<version>] …` section from `CHANGELOG.md` and sets it as the draft Release's description by id (`scripts/github-release.ts body`, [releasing.md](releasing.md#a-release-is-published-only-once-its-artifacts-are-attached)). It only sets `body`, so it never clobbers, and is never clobbered by, the asset uploads, in any job order. Empty section (chore/refactor-only release) → a "Maintenance release" fallback so the Release page is never blank.

## PWA install promotion

The manifest, icons and service worker have made the web app installable for a long time, but nothing in the app ever _said_ so — Chrome's own mini-infobar fired on its own 90-day schedule, and iOS Safari, which fires no `beforeinstallprompt` at all, said nothing. This is the in-app install experience from web.dev's [promote-install](https://web.dev/articles/promote-install) and [customize-install](https://web.dev/articles/customize-install), applied to this app's shape.

**Capture happens before Angular exists.** `captureInstallPrompt()` (`lib/install-prompt.ts`) is called from `main.ts` ahead of `bootstrapApplication`: Chromium fires `beforeinstallprompt` once, early, and never replays it, so a listener attached from a service that is first injected later sees nothing — the same no-replay trap `SwUpdate.versionUpdates` set for #1126. The listener calls `preventDefault()` (suppressing Chrome's infobar, so the app owns _when_ the prompt shows) and stashes the event; `InstallPromptService` reads the stash at construction and subscribes to later captures. Native shells never attach it — Capacitor and Electron _are_ the installed app.

**Two surfaces, one policy** (`installPromotionVisible`, pure and unit-tested):

| Surface                                                                                  | What                                                                         | When                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `InstallPromoBannerComponent` in the layout banner slot (under the welcome banner)       | The one-time nudge: title, one-line value pitch, **Install** + **Not now**   | Only after `beforeinstallprompt` was captured (or on iOS, where the manual instructions are the whole path); only for a signed-in user, which is the engagement signal the pattern asks for; never once installed, never inside a native shell, and never again after **Not now** on this device |
| Settings → Account & Devices → Updates (`settings-install-app` / `settings-install-ios`) | The permanent offer, next to "Check for updates" — where a user goes looking | Same gates minus the dismissal                                                                                                                                                                                                                                                                   |

`install()` calls `prompt()` on the captured event and awaits `userChoice`; the event is single-use, so it is dropped whatever the answer and the browser fires a fresh one if the page stays installable. `appinstalled` (which also fires for the omnibox install button) flips `installed` and hides every offer. "Already installed" is detected at boot by `isStandaloneDisplay()` — `display-mode: standalone|fullscreen|minimal-ui` or iOS's `navigator.standalone` — so an installed app is never asked to install itself.

**Dismissal is per device, not per user** (`nicotind-install-promo-dismissed` in localStorage, like the language): an install is a fact about the device. It is never re-shown on a timer; the Settings row is the way back. **iOS** is detected by UA (`isIosBrowser`, including the touch-Macintosh iPadOS UA) and gets "Share → Add to Home Screen" copy in both surfaces, with no Install button.

Not done, on purpose: no prompt on the login page (the user is not signed in yet), no in-feed or snackbar repetition, and no engagement counter beyond sign-in — the app is self-hosted and every visitor is already a member. Chromium in headless Playwright never fires the event, so `pwa-install.spec.ts` fires it itself through the real listener and asserts the product side: nothing before, both surfaces after, `prompt()` called once, refusal remembered across a reload with the Settings row intact.

## PWA updates

The Angular service worker (`provideServiceWorker('ngsw-worker.js')`, registered via `registerWhenStable:30000`) ships in every production browser build. It re-checks `/ngsw.json` **only on a navigation request** (`ngsw-worker.js`, `handleFetch`: `if (event.request.mode === "navigate" …) idle.schedule("check-updates-on-navigation", …)`). A tab left open all weekend therefore never re-checks, and an **installed home-screen app never re-checks at all** — iOS resumes the web view rather than navigating, and the SPA router handles every route change in-process.

That was first reported as "I deployed a new version and my browser kept showing the old one" and answered with a Settings → Account **Check for updates** button (`data-testid="settings-check-update"`). It came back worse from an iOS standalone install (#1126): the PWA stayed on an old build for weeks, and the button answered **"You're on v…"** while the server was serving something newer. Four independent defects, each sufficient on its own:

1. **The check lied about a staged update.** `UpdateService` mapped `sw.checkForUpdate()` straight through, but the driver returns `false` for a version it has _already set up_ — `if (this.versions.has(hash)) { notifyClientsAboutNoNewVersionDetected(…); return false; }`. The first check finds the update; every later one says "latest". Since the navigation check usually fires first, the button the user presses is almost always a later one.
2. **Nothing ever re-checked.** `checkForUpdate()` had exactly one caller, the button.
3. **Applying it needed a click that is free to never make.** `UpdateBannerComponent` was a **Reload to update** bar; ignoring it cost nothing. Worse, `versionUpdates` has no replay, so a `VERSION_READY` from a previous app session was invisible to this one and the bar never appeared.
4. **The server sent no cache directives.** Hono's `serveStatic` sets `Content-Type` and nothing else, so `index.html`, `ngsw.json` and `ngsw-worker.js` were all heuristically cacheable. See "Cache directives for the static build" below.

### The loop

`UpdateService.start()` (called once from `App`, the root component) adds the navigations an installed PWA never makes:

| Trigger                                                                     | Why                                                                                     |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `visibilitychange` → visible (via `createVisibilityPoller`, `pollOnResume`) | Resume is the only "navigation" a standalone app has                                    |
| `pageshow`                                                                  | A bfcache restore can arrive with no visibility transition                              |
| every 30 min while foregrounded                                             | The parked-tab case; paused while hidden, where a suspended app would not run it anyway |

`ready` is a sticky signal written from **three** sources, because no one of them is reliable: the `VERSION_READY` event, a `checkForUpdate()` that resolved `true`, and `probeServerBuild()` — `GET /api/health` reports the build the server is actually serving and is the only signal that survives a worker holding a stale manifest. `unrecoverable` reloads.

### The build decides, and an apply is verified

It came back a third time, from an iOS standalone install again: the server was on the heat-fix `:edge` build, the phone stayed on the previous release, and **Check for updates** kept answering **"You're on v0.8.119"**. Three more defects, each sufficient on its own:

1. **The version string cannot see an edge build.** Every green master commit is deployed as `:edge` carrying the _last release's_ `package.json` version, so the server and the stale phone both said `0.8.119` and `serverIsNewer()` — a strict version comparison — said no. The commit can tell them apart: the bundle is stamped with it (`BUILD_INFO.commit`, from `NICOTIND_BUILD_COMMIT`) and `/api/health` reports the image's. `servedBuildVerdict` (`lib/update-check.ts`, pure) compares **commits whenever both sides have one** — a different build is an update, since this server is the only thing that ever serves the shell — and falls back to "strictly newer version" only when either side is unstamped.
2. **"Couldn't check" was reported as "up to date".** Offline, the driver logs `Check for update aborted. (Client or server offline.)` and resolves `false`, and the health fallback swallowed its network error — so a phone with no route to the server announced its old build as current. The server is now asked **first**, with an 8 s bound (`HEALTH_PROBE_TIMEOUT_MS`); unreachable is its own outcome, `'offline'`, and the worker is not asked either, since its manifest fetch would fail the same way. The background check stands down the same way, which is also one less doomed request per resume offline.
3. **The reload could land on the old build.** When the server found the update but the worker had not staged it, `applyUpdate` activated nothing and reloaded — a navigation the worker answers **from its old cache**. It now makes the worker fetch the new manifest (`sw.checkForUpdate()`) before activating, and records what the reload should land on (`PENDING_UPDATE_KEY` in localStorage). The next boot's `verifyLastApply` compares that with the running commit (`afterUpdateReload`): landed → forget it; came back stale → **reset the worker** (`resetServiceWorker`: unregister it and drop only its `ngsw:*` caches — offline downloads are IndexedDB `nicotind-preserve` and untouched) and reload once more; out of attempts (`MAX_UPDATE_ATTEMPTS`, 2) or older than `PENDING_UPDATE_TTL_MS` → give up. The reset runs **only after reaching the server** (and never while `navigator.onLine` is false): a reset with no network would leave an installed app with nothing to load.

The up-to-date toast now names the build (`settings.updateUpToDateBuild`, "You're on v0.8.119 (build 37eae47)"), because a version alone cannot say which of two builds is running; About shows the same commit.

**A verification that is still running hides the strip (#1596).** Tapping Reload could land on the old build; the worker's navigation check then found the update again, and the same strip came back while `verifyLastApply` was about to reload anyway, which read as "Reload needs two taps". `updateAvailable` is now false until that verification settles, and neither `backgroundCheck` nor `maybeAutoApply` runs in that window, since a second apply would reset the attempt counter. An escalating reload leaves it set, so the strip stays down on the page being replaced. Anything else (landed, attempts spent, server unreachable) lets a staged update show again, so none is lost. The strip also names the build it is about to load (`targetBuild`), which tells a real second deploy from a failed first reload.

### Applying it in the background

Requested in as many words: _"force the update in the background too, to avoid dismissals."_ `canApplyUpdateNow` (`lib/update-policy.ts`, pure) is the whole policy, and it has exactly two constraints:

- **Never while audio is playing.** The reload tears down the `<audio>` element, and on the device that is the remote output it drops the cast for everyone driving it.
- **Never while the page is visible.** A reload mid-sentence loses a half-typed search, a settings field, a running import. Waiting for hidden costs nothing — the app is backgrounded many times a day and the reload is then invisible.

A backgrounded tab that is still the output is _playing_, and playing wins. Every trigger re-asks: the `VERSION_READY` itself, the page going hidden, and playback stopping. The banner is now a status line (**"Updating to the new version…"**) with an impatient button rather than a prompt, and `TvShellComponent` mounts it too — the TV tree previously had no update surface at all.

### Cache directives for the static build

`cacheControlForStatic` (`packages/api/src/services/static-cache.ts`) runs as a middleware _before_ `serveStatic`. Two answers, and the split is the build's own: a filename carrying a content hash (`-[A-Z0-9]{8,}\.(js|mjs|css)`) names one byte sequence forever and gets `public, max-age=31536000, immutable`; everything else gets `no-cache`, which means "revalidate before reuse", not "don't cache" — a 304 costs nothing when nothing changed. `/api/*`, `/doc` and `/openapi.json` are left to their own handlers.

**Pool and isolation (measured).** `pool: 'threads'` + `maxWorkers: '100%'` took the suite
from 134.7s to 113.1s; nothing here needs process isolation, so `forks` was pure spawn
overhead. `isolate: false` is the much bigger lever — **14.1s**, a 9x win, because
`test-setup.ts` imports `@angular/compiler` and that is re-evaluated for each of the 193
spec files — and it is deliberately **not** taken: three specs in
`desktop-window-controls.component.spec.ts` need `vi.mock` of `lib/platform` to resolve
per-file, and a shared module registry breaks that. Two _real_ bugs it surfaced were
fixed rather than left: `platform.spec.ts` and `native-capabilities.spec.ts` swapped the
global `window` for stubs and then `delete`d it instead of restoring the real one, which
is a latent landmine under any shared-worker config. Re-evaluate behind
`bun run check:isolated-specs --web`; `web-test` is its own CI job now, so the remaining
2 minutes are off the critical path.

### Design

- **Service**: `UpdateService` (`packages/web/src/app/services/update.service.ts`) bridges Angular's `SwUpdate` to signals. Exposes:
  - `enabled: Signal<boolean>` — `SwUpdate.isEnabled` **or the native Android APK path** (see below; false in dev, Electron, iOS, browsers without SW support).
  - `updateAvailable: Signal<boolean>` — sticky `true` once anything has staged a version (see "The loop" above for the three writers).
  - `applying: Signal<boolean>` — true from the moment `applyUpdate` starts until the reload replaces the page; the banner reads it.
  - `searching: Signal<boolean>` — gates duplicate clicks while a manual check is in flight.
  - `checkAvailable: Signal<boolean>` — `enabled && !updateAvailable`; the manual control only renders when this is true (the banner already owns the CTA once an update is staged).
  - `checkForUpdate(): Promise<'available' | 'up-to-date' | 'offline' | 'unavailable'>` — short-circuits to `'unavailable'` when `!enabled` or already `searching`. Then, in order: a version already staged is **`'available'` without asking the worker** (defect 1 above); otherwise `probeServerBuild()` — unreachable is **`'offline'`**, a different build is `'available'`; otherwise (same build) `sw.checkForUpdate()`, for a newer one already staged. Only then is the answer `'up-to-date'`.
  - `start(): void` — the background loop. A no-op wherever the SW is disabled.
  - `applyUpdate(): Promise<void>` — records the target build, makes the worker fetch the new manifest when the server found the update, then `sw.activateUpdate()` and `document.location.reload()`. A failed activation is swallowed rather than fatal: `verifyLastApply` on the next boot is the recovery (see "The build decides, and an apply is verified"). (jsdom doesn't allow redefining `location.reload`, so the test asserts against the stub's `activateUpdate`.)

- **UI** (`packages/web/src/app/pages/settings/settings.component.{ts,html}`): the Account section grows a `@if (update.checkAvailable()) { … }` button. On browsers it follows `SwUpdate.isEnabled` (so dev builds and Electron hide it); on the native Android/TV shell `enabled` is true via the APK path instead. It shows **Check for updates** by default and **Checking for updates…** + `disabled` while the check is in flight.

- **Outcomes → toasts** (existing `ToastService`, no new component):
  - `'up-to-date'` → green `"You're on v{version} (build {commit})"` toast (3 s); `"You're on v{version}"` on an unstamped build.
  - `'offline'` → red `"Couldn't reach the server, so nothing was checked — connect and try again."` toast (5 s).
  - `'available'` → blue toast (8 s) with **Reload** and **Later** actions; **Reload** dismisses the toast and calls `applyUpdate()`. The sticky banner appears once `VERSION_READY` fires anyway — the toast is the immediate feedback, the banner is the universal CTA.
  - error → red `"Couldn't check for updates — try again later."` toast.
  - Stale toast from a previous check is dismissed on a new click.

- **Parity matrix across releases**:

  | Surface                                               | Update mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | "Manual check" affordance                                                                                                             | PWA fallback path                                                        |
  | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
  | **PWA (web)**                                         | Angular service worker + `SwUpdate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `Check for updates` button → `UpdateService.checkForUpdate()`                                                                         | Banner (`UpdateBannerComponent`) owns `applyUpdate` once `VERSION_READY` |
  | **Electron** (`packages/desktop/electron/updater.ts`) | `electron-updater` polling GitHub Releases (`updateMode(platform, signed)`: Linux AppImage = apply, macOS = notify-only)                                                                                                                                                                                                                                                                                                                                                                            | Native `dialog.showMessageBox` on `update-downloaded` / `update-available`; feed attached to the Release by deploy.yml's desktop jobs | User opens **Releases page** link                                        |
  | **Capacitor Android / TV**                            | **In-app APK self-update from GitHub Releases**: `checkForUpdate()` reads `releases/latest`, compares via the shared `compareVersions` (`@nicotind/core`), and `applyUpdate()` has the `NicotindApkUpdate` plugin download the matching asset (`NicotinD[-TV]-<v>.apk`, chosen by `isTvUi()`) and open the system installer — shown only when Android's own package installer installed the app (`isSideloadInstaller`); see [docs/mobile-app.md](mobile-app.md) "Self-update from GitHub releases" | Same `Check for updates` button (the toast offers **Install** instead of Reload; a `settings-update-progress` line shows download %)  | The system installer owns the final accept/deny                          |
  | **Capacitor iOS**                                     | **No OTA** — reinstall the IPA from GitHub Releases                                                                                                                                                                                                                                                                                                                                                                                                                                                 | None — the button stays hidden (`enabled` is false off Android)                                                                       | —                                                                        |

  The reason the manual check is a _button_ rather than a _timer_: Angular's docs explicitly warn that long-running `setInterval` polling (the canonical "check every 6 h" snippet) **prevents the app from stabilizing and delays SW registration up to 30 s** (`ngsw-config.json` + `provideServiceWorker`). A user-triggered click is both the cheapest and the safest fix. Every NicotinD release already triggers a `chore(release):` commit and pushes a `vX.Y.Z` tag, so the SW's natural polling cadence is fine when the user actually opens the tab — the bug only surfaces for users who stay parked on the same tab for hours.

### Two earlier rejections, revisited (#1126)

The manual-button design rejected both halves of what now ships. Both rejections were reasonable and both were wrong in the standalone-PWA case, so they are recorded rather than quietly deleted:

1. **"Don't poll — it blocks SW registration."** True of the Angular docs' canonical snippet, which starts an unconditional `interval` at bootstrap. The loop here is a `createVisibilityPoller`: it stands down while hidden, its first tick is 30 minutes out, and registration is `registerWhenStable:30000` — a 30-minute timer is not what keeps an app from stabilizing. The reason the original reasoning does not carry is that "a user who stays parked on one tab" was treated as the edge case; on an installed PWA it is _every_ session.
2. **"The server version is not the PWA's version."** Still true of the _version_, which is why the comparison is now the **build**: this server is the only thing that serves the shell, so a server on a different commit than the running shell is proof the shell is stale, whatever the worker believes — and "the worker believes wrong" is exactly the reported state. It was once the last resort behind `SwUpdate`; since the edge-build report it is asked first. A false positive costs one reload; the false negative it replaces cost weeks on an old build.
3. **`sw.unrecoverable` → reload.** Was deferred "until a real stuck-cache report lands". It reloads now: an unrecoverable cache serves a broken app forever, and re-registering from scratch is the documented way out.

### Files touched

- `packages/web/src/app/services/update.service.ts` — `enabled`, `searching`, `checkAvailable`, `checkForUpdate`; then (#1126) the sticky `ready` signal, `start()`, `applying` and the auto-apply; then `probeServerBuild()` and `verifyLastApply()`.
- `packages/web/src/app/lib/update-policy.ts` — `canApplyUpdateNow`, the whole auto-apply policy, pure.
- `packages/web/src/app/lib/update-check.ts` — `servedBuildVerdict`, `parseHealth`, `afterUpdateReload`, the pending-update record and `resetServiceWorker`; spec'd in `update-check.spec.ts`.
- `packages/api/src/services/static-cache.ts` — `cacheControlForStatic`, plus the middleware in `packages/api/src/index.ts`.
- `packages/web/src/app/services/update.service.spec.ts` — enable/disable, search guard, available/up-to-date/error outcomes, reentrant safety, `applyUpdate` activation, and the #1126 group: a staged version never reports "up to date", the server beats a worker that says no, an older/unknown/unreachable server never invents an update.
- `packages/web/src/app/pages/settings/settings.component.ts` + `.html` — `searchForUpdates()` + `reloadToUpdate()` handlers; new `@if` button above the version chip.
- `packages/web/src/app/pages/settings/settings.component.spec.ts` — 8 new tests (visibility: enabled/disabled/staged; outcomes: up-to-date/available/error; re-entrancy via toast dismiss; pending-state UI).
- `packages/e2e/tests/pwa-update.spec.ts` — chromium-only assertion that the button **is visible** on the e2e server. The harness serves the **production** `@nicotind/web` bundle (`ng build` defaults to the production configuration with `serviceWorker: ngsw-config.json`) over http://localhost, where Chromium permits service workers — so `sw.isEnabled` is true and `checkAvailable()` resolves true, proving the `@if` gate renders the control in a real PWA build. The toast outcomes are covered by the unit tests because `SwUpdate` cannot be stubbed from outside the bundle, and driving the live SW round-trip through Playwright would hinge on flaky service-worker registration timing.
- `CLAUDE.md` (one-line index pointer) + this section.

### Gotchas

- **jsdom doesn't let you redefine `window.location.reload`**, so the `applyUpdate` test asserts against the stub's `activateUpdate` instead of intercepting the navigation (`update.service.spec.ts`); production behaviour is unchanged.
- **`UpdateService.start()` is called from `App`, not the app initializer.** `update.service.ts` imports `APP_VERSION` from `app.config.ts`; having app.config import the service back would be a module cycle. The root component is the same place `RemotePlaybackService.initialize()` and the rest of the once-at-bootstrap wiring lives.
- **Signal inputs do not bind in the web test setup.** `src/testing/signal-input.ts` exists because JIT does not reflect `input()` into component metadata — a template binding onto a child's signal input silently does nothing under vitest (`NG0303`, downgraded to a warning by `errorOnUnknownProperties: false`). Assert the parent's own wiring and let the child's spec cover the child.
- **`ngsw-bypass` still applies**: the stream URL helper (`ServerConfigService.streamUrl`) appends `ngsw-bypass=1` so `/api/stream/*` never hits the worker — orthogonal to this change but worth keeping in mind when reasoning about "the SW isn't picking up the new version".

## Service worker fire-and-forget

## A vertical scroller must constrain its other axis

`overflow-y-auto` on its own opts an element into **horizontal** scrolling too: when one axis is
`auto`/`scroll` and the other is `visible`, the visible one computes to `auto`. Any single pixel of
intrinsic overflow then becomes a sideways scrollbar instead of being clipped — and, inside a
full-screen sheet, drags the whole sheet with it.

That is what issue #992 was. The Now Playing queue panel set `overflow-y-auto` alone while the
lyrics and karaoke panels next to it already paired the axes, so the queue was the only one of the
four that could scroll sideways. The row titles had `truncate` and `min-w-0` the whole time and
looked correct in the markup — they simply never got the chance to apply.

`now-playing-scroll-axes.spec.ts` pins the rule across every Now Playing template rather than the
one line that was wrong, and asserts it found the templates first, because a vacuous pass is the
failure mode of a test shaped like that.

## The Now Playing header names the session, and radio wins

The header read a constant `NOW PLAYING`, so a radio, an album and an ad-hoc queue were
indistinguishable at the top of the sheet (#996). The signal was already present —
`player.context()` carries `{ type, name }`, and the queue panel one component over had always
read it.

`nowPlayingHeading` (`lib/now-playing-heading.ts`, pure) resolves it to an i18n key plus params.
The rule that matters is **radio wins over the context it extended**: a playlist that quietly
became a radio still read as the playlist, so the thing choosing the next track was not the thing
named at the top. When the radio is on the heading says _radio_ and names what it is about — its
station filter (`describeLibraryFilter`, reused rather than restated), else the album/playlist it
grew out of, else the track it seeded from. An ad-hoc queue is genuinely undetermined and falls
through to the plain title rather than inventing a label.

## The Now Playing chrome is slim: layout B (#1715, #1716)

The sheet's vertical space is the queue's. The title row used to carry four icons (♡ ⚑ ⓘ ⋯), and the
radio pill took a full row under the transport, growing by 170px when its dial opened. At 390x844
that dial left room for a quarter of a queue row. The owner compared four complete prototypes,
screenshotted at 390x844, 375x667 and 1280x800, and chose **layout B**:

- **The title stands alone** (`now-playing-title-row` has no buttons). Info and Report live only in
  the `⋯` track menu, the shared `SongMenuService` list.
- **The ⋯ sits on the artwork's top-right corner**, like a Mosaic tile
  (`now-playing-menu-toggle`, inside `now-playing-cover`). It falls back to the title row only while
  the cover is dragged away (#993), so the menu is never unreachable.
- **A still long-press on the artwork opens the same menu** (`NowPlayingCoverArtComponent.
onCoverPointerDown`). It follows the Mosaic and `EntityActionsDirective` contract: `HOLD_MS` held
  still, `HOLD_SLOP_PX` of travel cancels, `haptic('hold')`, touch and pen only (a mouse has
  right-click, which opens it too). A press on a control (the ⋯, a #1652 neighbour sliver) belongs to
  the control. A hold the sheet's swipe takes over is a swipe and skips, never a menu, and the click
  the release fires is swallowed so the menu it opened stays open.
- **Like leads the transport row and the radio control closes it** (`now-playing-like`, then
  `app-np-radio-control` → `now-playing-radio`), both 44px and in thumb reach.
  - With radio off, a tap on the radio icon starts radio.
  - With radio on, the icon shows an accent fill and a dot, and a tap opens the variety dial (#1660)
    as a menu panel: a bottom sheet on a phone (#1714). The dial carries the off switch
    (`np-radio-switch`), and it no longer pushes the queue down.
- **TV is unchanged**: its pinned D-pad chain (`now-playing-tv.spec.ts`) keeps prev / play / next,
  the ⓘ and the radio chip.

Measured at 390x844: 46px saved collapsed and 216px with the dial open; the visible queue grows from
about 1.06 to 1.81 rows. Covered by the transport and cover-art specs (row order, the transport Like,
the radio's one-tap start, the hold contract) and `now-playing-chrome.spec.ts` (row geometry, 44px
targets, ⋯ on the art, a still hold opens the menu and a moving one skips, radio on then dial).

## The Now Playing sheet shows no bitrate; Track info does (#1661)

The sheet used to stack a fourth text line under title / artist / album: `formatQuality(bitRate)`
with no format, so it only ever read `214 kbps`. The library is almost all Opus since the 2026-09
conversion, so that number is the bitrate of the _converted_ file, and a reader with MP3 habits
gets it wrong. Opus at 128 is generally transparent while MP3 at 128 is not, so 214 reads as
"ok MP3" and 96 reads as "bad". The library keeps no provenance either: once a FLAC or a 320 MP3 is
transcoded, nothing stored says what the source was. So the line told the listener little they
could use, could mislead them, and cost a line on every sheet.

The owner chose to **remove it from the sheet and keep it in Track info** (the `File` section's
`Bitrate` row, `data-testid="track-info-bitrate"`). That changes no data and is easy to undo. The
`now-playing-quality` testid went with the line. It was removed on purpose, and
`now-playing-cover-art.component.spec.ts` checks that the sheet renders no `kbps`. The download
cards, search results and folder browser keep their bitrate and format. There it helps the user
pick which file to fetch, which is a different question
([download-pipeline.md](download-pipeline.md#quality-chip--320-kbps--flac--1411-kbps)).

**Still open in #1700** (split from #1661): whether _any_ listener-facing quality signal is worth showing. That covers
codec-aware Opus bands justified from the library's bitrate distribution, a recorded source class
(which needs provenance captured at acquire time, forward-only, as its own issue), badges, and
where a signal would sit within the #1654 / #1651 viewport budget. Removing the line reclaimed the
space; it did not answer that question. A "Lossless" or "Hi-Res" badge would be false for a
transcoded file, whatever the review decides.

## The queue-resize notch is a drag target, so it clears 44px

A drag is the least forgiving interaction there is, and the notch offered ~20px of target around a
4px pill (#993). It is now `py-5` — 44px — padded symmetrically, since an asymmetric pair is what
made it read as belonging to the panel tabs below rather than as its own affordance.

The cover floor went from 120px to **0**. A floor of 120 handed most of the reclaimed space straight
back on exactly the device the drag exists for, and made the gesture feel broken rather than
bounded: the handle kept moving after the cover had stopped shrinking. `coverCollapsed` drops the
wrapper's `px-4 py-4` when it reaches zero — otherwise 32px of empty box outlives the artwork it
was padding, giving back part of what the drag just won.

## The waveform is mono, standing on the seek line

The symmetric min/max envelope spent half its pixels mirroring the other half — a waveform is
near-symmetric by construction, so the bottom lobe carried almost nothing the top did not.
`monoEnvelopePath` folds it (issue #994), which doubles the vertical resolution of the informative
half at the same strip height and puts the amplitude's base exactly on the seek line, so the graph
reads as growing out of the progress bar rather than floating either side of it.

The fold is `max(|min|, |max|)` per column, **not** a mean: a transient is a peak in one direction
only, and averaging would halve exactly the feature the strip exists to show — the same reason
`resamplePeaks` keeps min-of-mins and max-of-maxes upstream. The path closes along the baseline so it
can take a vertical gradient fill (transparent at the base, opaque at the peaks); a stroked polyline
could not.

## Shuffle and repeat are not in the UI (#1263)

Neither control did what its icon promised once radio became the way queues stay alive.

**Shuffle** reordered the queue you already had. Read against the rest of the app, where every tile
and every "surprise me" gesture starts a _radio_, that is the wrong verb on the wrong list — and its
off branch restores `context.originalOrder`, which silently drops whatever radio had appended.

**Repeat** was worse, because it did nothing you could name: the radio top-up effect skips while
`repeat !== 'off'`, so switching it on stopped the queue extending without starting a repeat of
anything — the queue simply ran out. Turning on "repeat" and getting silence is not a rough edge,
it is a control that lies.

Both buttons are gone from every surface: the mini bar
(`player-transport-mini.component.html`) and the Now Playing sheet
(`now-playing-transport.component.html`); the TV transport and the karaoke overlay never had them.
The Now Playing sheet's replacement for "surprise me" is radio: on a phone the radio control at the
end of the transport row (#1716, below), on TV the radio chip beneath it. Either toggles radio
(anchored on the current track when turned on over a bare queue).

**The service state stays.** `PlayerService.shuffle` / `repeat` are still signals, still persisted
in the player snapshot, and still read by `playNext()`, `playWithContext()` and the media-session
`ended` handler. Deleting them would be a behaviour change dressed as a cleanup; deleting the
_buttons_ is the behaviour change that was asked for, and it leaves a remembered `shuffle: true`
from before this change inert rather than stranded.

Gone with the shuffle button: the hold-for-radio gesture (#995) and the `LongPress` helper that was
its only user. The gesture's destination — a radio seeded on this track — is one tap away on the
chip below it, so the hidden shortcut was the only thing lost.

## Mini player chrome and slim seek (#1638)

The mini player used to be the tab bar's own `bg-theme-surface` with a `border-t` hairline as the only seam, so player and nav read as one slab. It is now `.player-chrome`: a soft upward shadow (`--theme-elevation-up`, one value for the dark themes, one for Daylight/Warm Paper, a plain hairline on E-Ink) lifts it off the content above, and its background descends from `--theme-surface` toward `--theme-bg`, so its lower edge meets the tab bar as a visible seam. It stays **opaque**: the mosaic stops above the bottom chrome, so a blur would have nothing behind it, and fixed layers with `backdrop-filter` already misbehave on iOS (#1635).

Its two scrubbers (desktop inline, mobile under the row) sit in `.player-mini-seek`, which slims the shared `app-seek-bar` there only — the sheet, karaoke and poll scrubbers keep their look: a 3px track, a fainter buffered band, and a 10px thumb that grows to 1.4× while active or focused (on hover only under `@media (hover: hover)`, since `:hover` sticks after a tap). On touch the thumb is hidden at rest — the fill says where you are, and the native range still jumps to the tapped point; the 20px hit box is untouched. The raised play button's shadow drops from `shadow-lg` to `shadow-md`; #1263's target sizes are an accessibility floor and stay. The output icon was already `text-theme-muted`; the bar carries no like heart (#1650 — it lives on the Now Playing sheet, see [song-actions.md](song-actions.md)). Covered by `player.component.spec.ts` ("chrome").

## Mini player spacing (#1743)

The owner found the bar cramped: on desktop the raised play button overlapped the notch pill by 2px
and the inline scrubber's column (play 40px + 4px + scrubber 20px) was taller than the fixed `h-14`
row, so it hung 4px below the viewport with its `0:00` / `4:03` labels on the screen edge; the title
and artist were 14px and 12px. The measured spacing now (1280×800 and 390×844, from
`mini-player-spacing.spec.ts`):

|                            | Desktop before → after                  | Phone before → after            |
| -------------------------- | --------------------------------------- | ------------------------------- |
| Bar height                 | 78px (content overflowing to 82) → 96px | 98px → 104px                    |
| Notch pill → play button   | −2px → 10px                             | 10px → 12px                     |
| Scrubber box → bar edge    | −4px → 8px                              | 0px → 6px                       |
| Title / artist             | 14 / 12px → 16 / 14px                   | 14 / 12px → 16 / 14px           |
| Prev · play · next targets | 36 · 40 · 36px (unchanged)              | 36 · 40 · 36px → 44 · 44 · 44px |

How: on desktop the row drops its fixed height (`md:h-auto`) and takes its height from the
transport column plus `md:pb-2`, and the grab band's bottom padding (`md:pb-2.5`) is the whole
notch → button gap, since the column starts at the row's top. On a phone the row stays `h-14`, the
44px buttons centre in it (6px each side), and the stacked scrubber loses its `-mt-1` tuck and gets
`pb-1.5`, so its 3px track sits 14.5px below the play button and 14.5px above the bar's edge.
The play button lost its lift (see "Transport buttons are sized for a thumb"). Title and artist are
`text-base`/`text-sm` at `leading-5`, a 40px block matching the 40px cover; the desktop info column
widened from `md:w-60` to `md:w-72` to keep long names readable at the new size, and the time labels
are `tabular-nums` so the row does not jitter while it counts. The bar is still measured
(`--mini-player-h`, #1694), so the scroller reservation and the toast stack (#1699) follow it with
no change. Covered by `player.component.spec.ts` ("chrome"), `player-transport-mini.component.spec.ts`
(the 44px phone floor, no lift) and `mini-player-spacing.spec.ts` (e2e: both layouts).

## Transport buttons are sized for a thumb (#1263)

Prev/play/next were laid out for a dense desktop bar: 28px taps with 16px glyphs on the mini
player, 40px with 22px glyphs on the sheet. Every one of them is ~25% larger now — mini
`w-9`/`w-10` with 20/18px glyphs, sheet `w-[3.125rem]`/`w-[4.375rem]` with 28px glyphs — which is
also what moves the mini bar's prev/next closer to a real 36px target.

The mini play button was additionally raised (`-translate-y-1`) to break the row's baseline. #1743
retired the lift: on desktop it put the button 2px into the grab notch, so it now sits on the row's
centre line and its filled disc alone sets it apart. On a phone every mini button is now a full 44px
target (`w-11 h-11`, desktop keeps `md:w-9`/`md:w-10`) — see "Mini player spacing (#1743)".

## Keyboard shortcuts (issue #1296)

One table, `SHORTCUTS` in `lib/keyboard-shortcuts.ts`, is both what `KeyboardShortcutsService`
dispatches from and what the `?` sheet (`KeyboardShortcutsSheetComponent`, mounted in the layout
shell, `data-testid="shortcuts-sheet"`) renders, so a key cannot work without being listed or be
listed without working. The mapping is the pure `keyToAction(event, context)`: the service reduces
the DOM to four booleans (TV build, TV `/player` route, text-entry focus, natively activatable
focus) and the table is unit-tested without a DOM (`keyboard-shortcuts.spec.ts`).

| Key               | Action                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Space / K         | play / pause (Space yields to a focused button's own activation)                                                              |
| ← / →             | seek −5 s / +5 s (held keys repeat)                                                                                           |
| Shift+← / Shift+→ | previous / next track                                                                                                         |
| L                 | like the current track (`LikeService.toggle`)                                                                                 |
| R                 | start a radio from the current track (`PlayerService.startRadio`, the song menu's path — it restarts the track as the anchor) |
| N                 | toggle the Now Playing sheet                                                                                                  |
| Q / Y             | open the sheet on the Queue / Lyrics tab (`PlayerService.showNowPlayingPanel`)                                                |
| M                 | mute / unmute vocals                                                                                                          |
| /                 | focus the page's own visible search box, else go to the library and focus its find box                                        |
| Esc               | close the innermost overlay                                                                                                   |
| ?                 | toggle the shortcut sheet                                                                                                     |

Decisions:

- **Shift on the arrows means prev/next, not ±30 s.** The issue listed both for the same chord;
  track skip is the one users reach for, and seeking further is a held arrow.
- **Esc is listed but not dispatched here.** It belongs to `BackButtonService`'s Escape listener and
  the shared `BackHandlerStack` (issue #398), which closes karaoke fullscreen, then the track-info
  sheet, then Now Playing, innermost first — and must keep working from inside a text field, where
  this table never fires. The row has `scope: 'back-stack'`; the sheet registers its own closer.
- **Never from a text field**: `isTextEntryTarget` (`lib/text-entry.ts`,
  `input,textarea,select,[contenteditable]`) is the same guard the pull-to-refresh gesture uses.
- **Never on a Ctrl/Meta/Alt chord** (Alt+← is Back, Ctrl+L the address bar, Cmd+M minimize), and
  never on a keypress something already `preventDefault`-ed (a D-pad nav group, the side-panel
  splitter).
- **Media keys are not in the table**; they stay with the media session, so nothing double-fires.
- **Inert on the TV build** except ◀ ▶ = ±10 s on the `/player` route (issue #438, the `tv-player`
  scope): the D-pad owns every other key there. See [tv-ux.md](tv-ux.md).
- **No volume keys.** The app has no volume or mute control to drive; M keeps its existing meaning
  (vocal mute), and ↑ / ↓ volume was not built.
- **J is gone.** L became like, so the old J/L prev/next pair moved to Shift+← / Shift+→.

`now-playing-desktop.spec.ts` presses Space, Esc, `/` and `?` in a real browser, and checks that
typing into the focused search box is typing, not a shortcut.

## Bundle size budget (issue #256)

`packages/web/angular.json` carried the **untouched Angular CLI scaffold defaults**
(`initial` 500 kB warning / 1 MB error), which the app has exceeded for long enough that the
warning became part of expected build output. A warning that is always red is a warning nobody
reads — the real cost is that the next genuine regression looks identical to the status quo.

**Measured before deciding.** `ng build --stats-json`, attributing `bytesInOutput` for the
initial chunk:

|               | raw       | transfer      |
| ------------- | --------- | ------------- |
| initial total | 734.78 kB | **187.63 kB** |

| package                                                                           | initial chunk |
| --------------------------------------------------------------------------------- | ------------- |
| **@sentry/\*** (replay 124 + core 85 + browser-utils 30 + browser 29 + angular 4) | **272 kB**    |
| @angular/core                                                                     | 142 kB        |
| @angular/router                                                                   | 77 kB         |
| **app code**                                                                      | **72 kB**     |
| @angular/common                                                                   | 26 kB         |
| rxjs                                                                              | 21 kB         |

Two things that decide the question:

1. **The budget measures raw bytes; users pay transfer.** 735 kB raw is 188 kB over the wire,
   which is unremarkable for an app of this scope. "47 % over budget" was measuring the wrong
   number against a threshold nobody chose.
2. **42 % of the initial chunk was Sentry — now lazy-loaded (issue #285, resolved).** When #256
   raised the budget, Sentry was eager: `main.ts` called `initSentry` _before_
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
on the next feature. The win is a smaller _actual_ initial chunk, not a tighter budget.

**`qrcode` is now lazy.** It was a static import in `devices.component.ts`; it is now
`await import('qrcode')` inside `renderQr`, which took the devices route chunk from **38.9 kB
to 14 kB** and moved the library into its own 24 kB chunk fetched only when a pairing QR is
actually minted. This does **not** silence the "not ESM" warning — that is CommonJS interop and
is unaffected by import style; a dynamic import in fact surfaced a second one (`dijkstrajs`).
Those two are declared in `allowedCommonJsDependencies`, which is Angular's sanctioned way to
acknowledge a known CJS dependency, so the build is now **warning-free** and the next warning
means something. Note the trade: a broken static import fails the build, a broken dynamic
import fails at click time — hence `devices.component.spec.ts` covers the QR path.

## Viewport deficit (iOS standalone band under the tab bar)

Measured over USB on an iPhone 13 mini in standalone mode: `innerHeight`/`dvh`/`svh` = 762 but `lvh` = 812
(screen 812, top inset 50). The layout viewport is short by the top inset, so `fixed bottom-0` and the
`100dvh` shell both stop 50pt above the real bottom, and the canvas shows through as a band. The strip is
inside the web view and paintable (a red `html` background filled it), so CSS can reach it.

`styles.css` publishes `--vp-deficit` = `max(0px, 100lvh - 100dvh)` **only under
`@media (display-mode: standalone)`** (0 elsewhere: in a browser tab `dvh < lvh` is the collapsing
toolbar, which fixed bars must keep following). The shell height, the tab bar, the mini player, the toast
outlet and the update banner add it back, so on a healthy viewport nothing changes and when iOS reports
the right height the offset disappears by itself. `measureBottomChromeInset` needs no change: modal
backdrops are `fixed inset-0`, sized to the same short viewport. Asserted in `mobile-ux.spec.ts`
("bottom chrome extends by the viewport deficit", forced via the variable, since Chromium cannot
reproduce the short viewport); the real numbers come from `bun run phone-preview`
([phone-preview.md](phone-preview.md)).

## The shell scrolls `<main>`, not the document (iOS PWA fixed-bar drift)

On an iOS standalone PWA the fixed mini-player and tab bar rode the page's scroll: scrolling Settings with a
track loaded left both floating mid-screen, shifted by the scroll distance, with content visible beneath. WebKit
mishandles `position: fixed` against a _document_ scroller there, and no CSS on the bars themselves cures it.
So the layout shell is now a fixed-height column (`h-dvh overflow-hidden`) and `<main data-scroll-root>` is the
one scroller; the document never scrolls, so there is nothing for the fixed layers to drift against. Routes
outside the shell (login, setup) still scroll the document.

Anything that used `window.scrollY` / `window.scrollTo` goes through `lib/scroll-root.ts`
(`scrollRootTop` / `scrollRootTo`, `window` fallback outside the shell): the pull-to-refresh start check and the
Library's scroll persistence. `ScrollLockService` locks both the root and the scroller. Horizontal-overflow
e2e checks measure the document **and** `[data-scroll-root]`, since `overflow-y: auto` makes `<main>` the
element that would overflow. Regression: the `mobile-ux` e2e "scrolling a long page leaves the player and tab
bar pinned to the bottom". Not reproducible in Chromium or CI (no iOS WebKit) — on-device confirmation needed.

**Held tiles and the entity menu are not selectable** (`user-select: none` on `.mosaic-tile` and the menu): a
press-and-hold opens the menu, and the drag that follows used to start an iOS text selection (the Copy / Look Up
/ Translate bubble) over the menu.

## The scroller reserves the measured bottom chrome (#1694)

At maximum scroll the last element of every view ended about 26px under the mini player. `<main
data-scroll-root>` reserved the tab bar plus a **constant** 4.5rem (72px) for the mini player, written when the
bar was a 56px row; the grab notch (22px) and the mobile scrubber (20px) later made it ~98px and the constant
never followed. The scroller from #1646 did not cause it, it only made the end of the scroll the place you look.

There is now one reservation, `MAIN_BOTTOM_PAD_CLASS` (`lib/player-chrome.ts`): the tab bar's own
`3.5rem + env(safe-area-inset-bottom)` on phones, plus `var(--mini-player-h)`. `PlayerComponent` measures its
bar with a `ResizeObserver` and publishes the height on `<html>` through `miniPlayerReservation`: the real height
while a track is loaded, `0px` while idle (the bar is slid off-screen) and on TV (no bar). So the "Playing on"
strip, a font-size change or a future control is reserved without anyone updating a number. The slide is a
transform, which does not change the box, so the observer fires only on real size changes. It observes the
**border box**, the one `getBoundingClientRect` measures: the default content box never fires on a padding or
border change. There is no
`--vp-deficit` term: the shell grows by the deficit and the chrome is anchored to the shell's bottom, so `<main>`'s
bottom and the chrome's move together. The `bottom-reservation` e2e scrolls Library → Songs and Settings to the
bottom at 390x844, with no track, with a track, with a forced 50px deficit, and with the bar grown 40px after first
render (plus Library → Songs on a 1280x720 desktop with a track). It asserts from both sides that the lowest painted
element ends at the topmost visible `[data-bottom-chrome]`: not below it, and not more than 2px above it (the
measured gap is 0px), so an over-reservation such as a double-counted deficit fails too. Track cases first assert
the track survived the reload and `--mini-player-h` is not `0px`. On-device check: `bun run phone-preview`
([phone-preview.md](phone-preview.md)).

## The toast stack sits above the measured bottom chrome (#1699)

Toasts are `z-[60]`, above the mini player's `z-50`, and the stack was anchored at a constant `5rem` on phones
(`md:bottom-24` on desktop), written when the bar was a 56px row. With a track loaded on a phone the bar now spans
roughly 56-154px from the bottom, so the lower part of every toast covered the player's track info and transport
controls. The stack now anchors on the same measured `--mini-player-h` as the scroller, through
`TOAST_STACK_BOTTOM_CLASS` (`lib/player-chrome.ts`): on phones the player's own anchor (`3.5rem +
env(safe-area-inset-bottom) - var(--vp-deficit)`) plus its height plus a 0.5rem gap; on desktop the player's height
plus 1rem, minus the deficit the desktop player is anchored on too. With no track (and on TV, which renders no bar)
the height is `0px`.

The update strip (`UpdateBannerComponent`) is a second fixed layer on the viewport bottom, ~53px tall, and it is
not `[data-bottom-chrome]`. It stays up for as long as the page is visible and nothing plays, which is exactly the
no-track state, so a toast 1rem above a `0px` player sat on its text. The strip therefore publishes its measured
height as `--update-banner-h` (`UPDATE_BANNER_HEIGHT_VAR`, `0px` while hidden), and both branches anchor on
`max()` of the chrome and the strip. On TV the stack is floored at the overscan band too: `styles.css`
(`html.tv-build [data-testid='toast-stack']`) sets `bottom` to that `max()` with `--tv-overscan-y` plus 1rem, so the
'extra' preset (4vh) never crops a toast.

The `toast-offset` e2e raises a toast (the album page's curator Complete action, routed) and asserts from both sides
that the stack's lowest edge ends that gap above the topmost visible `[data-bottom-chrome]` or update strip (within
2px): on a 390x844 phone with and without a track, under a forced 50px deficit and with the bar grown 40px after
first render, on a 1280x720 desktop with and without a track, on desktop with no track and the real strip staged
(a routed `/api/health` reporting another build, then Settings → "Check for updates"), and at 960x720 with
`tv-build` stamped on the 'extra' preset. On the old offset the phone track case overlapped the bar by 74px.

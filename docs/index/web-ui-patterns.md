# Web UI patterns

One section of [the index](../index.md). Entry shape and caps are unchanged and
`bun run check:claude-md` still enforces them here.

- **A vertical scroller constrains both axes**: `overflow-y-auto` alone computes `overflow-x` to
  `auto`, so a sheet scrolls sideways and `truncate` never applies; pinned by
  `now-playing-scroll-axes.spec.ts`. → [web-ui.md](../web-ui.md)
- **Rows never widen the page**: rows wrap and flex children get `min-w-0`; a `data-x-guard`
  `overflow-x-clip` backstop; `horizontal-overflow-policy.spec.ts` (template rules) and
  `horizontal-overflow.spec.ts` (every route, `expectNoHorizontalOverflow`). → [web-ui.md](../web-ui.md)
- **Now Playing sheet**: `nowPlayingHeading` names the session (radio wins over the context it
  extended); `coverCollapsed` drops the cover padding at the notch's zero floor; `monoEnvelopePath`
  folds the waveform onto the seek line. → [web-ui.md](../web-ui.md)
- **Shuffle and repeat are not in the UI**: both buttons are gone — shuffle reordered the queue
  instead of starting a radio, repeat only stopped the radio top-up. `PlayerService.shuffle` and
  `repeat` stay, since `playNext` reads them. → [web-ui.md](../web-ui.md)

- **Cover URLs carry the cover rev**: `/api/cover/<id>` is built through `CoverRevisionsService.url`
  with a `CoverRef` (required `coverRev`, owning entity) from `artistCover`/`albumCover`/`songCover`;
  `coverUrl` spells `v=<rev>`; a sweep spec fails a hand-built one. → [cache-invalidation.md](../cache-invalidation.md)
- **Unified song listings**: one `TrackRowComponent` + one root `SongMenuService.build(song, ctx)`
  builds every `⋯` menu; every album/artist name is an `EntityLinkComponent` link (span on TV for
  artists); Remove routes through `ConfirmService` → `deleteSongs` → `deletedSongIds()`;
  multiselect is one `createSelection()` + `SelectionBarComponent` everywhere.
  → [song-actions.md](../song-actions.md)
- **Tile interaction standard**: hover ⋯, right-click and touch hold open one entity menu
  (`EntityMenuHostComponent`, `EntityMenuService.open`) on every tile and row; albums, artists,
  genres and playlists get `EntityMenuService.build` (Start radio first), songs keep the song menu;
  `EntityActionsDirective`, `EntityMenuButtonComponent`. → [web-ui.md](../web-ui.md)
- **Keyboard shortcuts**: one `SHORTCUTS` table is both what `KeyboardShortcutsService` dispatches
  (via the pure `keyToAction`) and what the `?` sheet renders; `isTextEntryTarget` is the shared
  typing guard. → [web-ui.md](../web-ui.md)
- **Unified search**: `GET /api/search?q=` blends local library and parallel network results into one
  source-agnostic list. → [source-agnostic-acquisition.md](../source-agnostic-acquisition.md)
- **One album grid per artist tab**: library albums and the MusicBrainz discography merge into a
  single ordered set of tiles — owned, partial (`Complete album`) or missing (`Get album`) — joined
  on the server's `localAlbumId`; the unowned non-studio tail collapses behind a toggle.
  `buildArtistAlbumTiles`, `albumCompleteness`, `partitionTiles`, `AlbumTileComponent`.
  → [web-ui.md](../web-ui.md)
- **Library cross-type find bar**: one box above the Library tabs searching everything you own at once
  (`LibraryFindComponent`); a non-empty query *replaces* the tab content rather than filtering the
  active tab, debounced into `?find=` so it is linkable. → [web-ui.md](../web-ui.md)
- **Library tab bar and toolbars, one row each**: tabs are icons with only the active one labelled
  (inactive labels `sr-only`), Songs first and `DEFAULT_LIBRARY_MODE`; toolbars are
  `SearchFieldComponent` + `SortSelectComponent` (a transparent native select over an icon) + the
  filter panel's `compact` trigger. → [web-ui.md](../web-ui.md)
- **Library "Songs" tab**: `GET /api/library/songs` backs a first-class flat listing with the shared
  filter, `TrackRowComponent` and multi-select; offline it swaps its source to
  `PreserveService.preservedTracks`. → [web-ui.md](../web-ui.md)
- **Artist page — tabbed**: Albums | Singles & EPs | Songs, the last lazy and paginated with bulk
  actions including the only view that can remove albumless files.
  → [design-patterns.md](../design-patterns.md)
- **Viewport-safe dropdown menus**: `MenuPanelComponent` flips above or clamps into the viewport via
  the pure `computeMenuPosition`, reserving a `bottomInset` from `bottomChromeInset` so it never opens
  under the mini-player. → [design-patterns.md](../design-patterns.md)
- **Bottom-chrome stacking + scroll lock**: mini-player and tab bar share one plane;
  `ScrollLockService` pins the document under sheets; `BottomChromeSafeDirective` +
  `measureBottomChromeInset`/`measureTopChromeInset` + `modal-max-h` keep modals reachable.
  → [design-patterns.md](../design-patterns.md)
- **Blur + stacking contract**: `backdrop-filter` only on modal backdrops, inside the sheet, a
  chrome-less page, a transient `.glass-panel`, or in-page layers that stand down under it
  (`mosaic-covered`); `backdrop-blur-policy.spec.ts` holds the allowlist. → [design-patterns.md](../design-patterns.md)
- **Page & section idioms**: every routed page inside the shell has a `page-shell` root with a width
  cap, grouped pages share `SettingsGroupComponent`, tables use `section-flush`; `page-shell.spec.ts`
  is the drift guard. → [web-ui.md](../web-ui.md)
- **In-app licence + source offer**: `/settings/about` states AGPL-3.0-only and links the §13
  corresponding source, pinned to the exact tree when the bundle is stamped at build time
  (`AboutComponent`, `resolveBuildInfo`, `APP_BUILD_INFO` from `ng build --define`); third-party
  notices are a declared gap. → [licensing.md](../licensing.md)
- **Settings-cards unification**: one bordered collapsible `SettingsGroupComponent` backs every group
  across every settings-family view, collapsed by default and persisted per device via
  `group-state.ts`; `settings-consistency.spec.ts` is the cross-view gate.
  → [design-patterns.md](../design-patterns.md),
  [admin-settings-decoupling.md](../admin-settings-decoupling.md)
- **Admin/Settings/Extensions decoupling**: core Settings holds universal prefs only, server-admin
  tools live in Admin, and each addon renders through the generic `PluginCardComponent` +
  `AddonStatusPanelComponent`. → [admin-settings-decoupling.md](../admin-settings-decoupling.md),
  [plugins.md](../plugins.md)
- **Admin is one panel component per section**: `admin.component.html` is an ordered list of tags
  (reorder = one line); each panel owns its `<app-settings-group>` (`groupId` = localStorage key
  *and* e2e selector) and injects `ServiceReviewService` rather than taking inputs;
  `AcquisitionSettingsService` is the one cross-section signal.
  → [admin-settings-decoupling.md](../admin-settings-decoupling.md)
- **ServiceReview (one resource, one polling lifecycle)**: `GET /api/admin/review` replaces the Admin
  page's N loaders; `ServiceReviewService` owns one visibility-paused interval and every sub-section
  is a `computed()` slice. Slices are gathered by name via `allNamed()`, never positionally.
  → [design-patterns.md](../design-patterns.md)
- **List loading skeletons**: one shape-matched `SkeletonComponent` replaces the copy-pasted list
  spinner, so a spinner now means only "an action you started is in progress".
  → [web-ui.md](../web-ui.md)
- **Pull-to-refresh (touch)**: one layout-hosted gesture on `<main>` (`pull-to-refresh.ts` composing
  `createPointerDrag`) plus a `PullToRefreshService` handler stack pages register into,
  coarse-pointer-gated. → [web-ui.md](../web-ui.md)
- **Top bar back control**: pages register their back target with `PageBackService`; the layout
  renders the one arrow beside the logo, and below md the bar shows only then
  (`headerDisplayClass`, `statusScrimVisible`). → [web-ui.md](../web-ui.md)
- **Vertical swipe (own-or-release)**: `createVerticalSwipe` arms the touchmove blocker at
  pointerdown and asks `resolve` once; `shouldCommit` (distance or `flickVelocity`) commits. The
  mini-bar live-follow open, the Now Playing mode table (resize/dismiss, continuation) and the
  `lg:` side-panel splitter (`sidePanelWidthPx`). → [web-ui.md](../web-ui.md)
- **Player panel snap points (proposal, #1651)**: one hidden/rest/full state machine for the Now
  Playing panel, folding `karaokeFullscreen` and `resolveLyricsScrollContainer` in, with a
  declarative tab contract and a migration off `queueExtraHeightPx`. → [player-panel.md](../player-panel.md)
- **Queue row gestures**: `createRowGesture` — swipe left removes with Undo (`insertInQueue`),
  long-press then drag reorders (`reorderTargetIndex`); blocker armed only at the long-press.
  → [web-ui.md](../web-ui.md)
- **Swipe to skip**: `createHorizontalSwipe` on the full Now Playing sheet (not the mini bar), arbitrated
  against the vertical swipe by `dominantAxis` and a per-pointer claim; `skipDirection` commits,
  `haptic('commit')` ticks. → [web-ui.md](../web-ui.md)
- **Haptic vocabulary**: call sites name an event (`haptic('tap' | 'hold' | 'commit' | …)`), one
  `HAPTIC_MAP` turns it into a plugin call or `navigator.vibrate`; `hapticEnabled` gates on the
  per-device Off/Reduced/Full level, `HapticDirective` is the template door, lint bans other doors.
  → [mobile-app.md](../mobile-app.md)
- **Neighbour carousel**: the sheet's ±1 cover strip at rest, read from `nextNeighbour` /
  `prevNeighbour`; a tapped sliver emits `skipRequested`. → [web-ui.md](../web-ui.md)
- **PWA install promotion**: `captureInstallPrompt` stashes `beforeinstallprompt` before bootstrap;
  `InstallPromptService` + `installPromotionVisible` drive a one-time layout strip
  (`InstallPromoBannerComponent`) and a permanent Settings row, iOS gets manual copy.
  → [web-ui.md](../web-ui.md)
- **Reactive network / offline detection**: `NetworkStatusService` is one live `online` signal **plus a
  monotonic `reconnects` counter**, because signals coalesce and a fast offline/online pair is
  invisible to a diff of `online`. `isOffline` is a `computed`;
  `reportServerFailure`/`reportServerSuccess` flip it both ways mid-session.
  → [mobile-app.md](../mobile-app.md)
- **PWA updates apply themselves**: `UpdateService.start()` re-checks on resume, `pageshow` and a
  30-min timer — the navigations an installed standalone app never makes — and `canApplyUpdateNow`
  activates in the background, never while playing or visible; `probeServerBuild` compares commits
  (`servedBuildVerdict`), and `verifyLastApply` resets a worker that reloaded stale. → [web-ui.md](../web-ui.md)
- **The TV says where the audio is**: `TvDevicePickerComponent` is the D-pad output chooser (a
  full-screen list, never the phone popover a remote cannot dismiss), sharing `otherDevicesFor` with
  it; `TvShellComponent` routes to the player when a cast lands here.
  → [remote-playback.md](../remote-playback.md), [tv-ux.md](../tv-ux.md)
- **Per-spec playback session reset**: every e2e spec imports `test` from `helpers.ts`, whose auto
  fixture `freshPlaybackSession` ends the caller's remote-playback session before each test, because
  a torn-down context fires no `pagehide` and the leaked track outlives the release grace.
  `PlaybackStateManager.reset`, `playbackRoutes`, `playback-isolation.spec.ts`. → [e2e.md](../e2e.md)
- **The TV tree in Chromium**: the e2e `tv` project serves `ng build --configuration tv` through
  `NICOTIND_WEB_DIST` on a third managed server and screenshots every TV screen at 960×540, because
  stamping `tv-build` on the phone bundle never renders `isTvBuild()`'s route tree. `TV_DIST`,
  `seedAdminAndLibrary`, `expectNoNativeFormControls`, `tvbuild.spec.ts`. → [e2e.md](../e2e.md)
- **Changelog modal**: build-time `CHANGELOG.md` → `changelog.json`, capped; the version string in
  header and settings is clickable. → [web-ui.md](../web-ui.md)
- **Shared relative time**: one `timeAgo` (`lib/relative-time.ts`) for the Downloads feed and Admin
  users table, with the translator an optional param so the module stays pure.
  → [presence-tracking.md](../presence-tracking.md)
- **Names never unreadably truncated**: `OverflowRevealDirective` scrolls an overflowing name's own
  `scrollLeft` (touch: once when settled; desktop: hover/focus; TV: focus; the playing title always;
  reduced motion: tap to wrap); `overflow-reveal-policy.spec.ts` gates every truncation.
  → [web-ui.md](../web-ui.md), [design-patterns.md](../design-patterns.md)
- **Theme audit (2026-11)**: every surface × the 7 presets on phone, desktop and TV, where the palette
  is flat, a contrast table for today's tokens, and the owner's closed questions before #1683;
  `placeholderGradient`, `SettingsGroupComponent`. → [theme-audit.md](../theme-audit.md)

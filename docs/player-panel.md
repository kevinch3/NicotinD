# Player panel: one snap-point state machine (design proposal)

**Status: decided (owner, 2026-11-09), not built.** This is Step 0 of #1651 (sub-issue #1677). It
unblocks #1678 (pure state machine), #1679 (full height, and the pull-down past rest), #1680 (karaoke fold) and #1681 (tab registration
and coverage), and it coordinates with #1668 (the shared tab component). Nothing here describes
shipped behaviour except the "Today" sections, and each claim there cites `file:line` on `master`
at `c5671c23`. Anything marked **assumption** was not verified in code.

Owner decision already taken (#1651, 2026-11-07): tapping Queue or pulling up extends the panel to
**full height, showing its notch**. Pulling down returns it to rest, and pulling further slides it
**off scene**. Karaoke and future tabs share the same state machine.

**Owner decisions (2026-11-09)**, recorded in full under "Decisions" at the end:

| | Answer | Effect on this proposal |
| --- | --- | --- |
| D1 | **C**: no `hidden` state | "Further down" keeps meaning *dismiss the sheet*. There is no off-scene snap and no peek strip. |
| D2 | **A**: the origin decides | Stage down-pull dismisses in 120 px. A panel down-pull from `rest` continues into a dismiss; one from `full` stops at `rest`. |
| D3 | **A**: fixed snaps, so **two** | With D1 = C the snaps are `rest` and `full`. The cover shrink is only the animation between them. |
| D4 | **A** | An inactive tab switches and keeps the snap; the active tab toggles `rest` ↔ `full`. |
| D5 | **A** | Karaoke is the Lyrics tab at `full`. |
| D6 | **A** | A compact transport strip above a `full` Queue; karaoke brings its own chrome. |

The sections below are written to these answers. #1651's "slide it off scene" is therefore the
sheet's own dismiss, reached by pulling the panel down from `rest`.

Paths below are relative to `packages/web/src/app/` unless they start with `docs/` or `packages/`.

## 1. Today

### 1.1 One body gesture, two ad-hoc states

- The sheet root binds `(pointerdown)="onBodyPointerDown($event)"`
  (`components/now-playing/now-playing.component.html:16`). The root is `fixed inset-0 z-[60] …
  touch-pan-y` and switches between `transition-none` and `transition-transform duration-300`
  (`now-playing.component.html:12-13`).
- `onBodyPointerDown` returns early under karaoke (`if (this.karaokeFullscreen()) return`,
  `now-playing.component.ts:350`). It skips `BODY_NO_SWIPE` targets (`:308-309`, `:353`), starts the
  horizontal skip swipe when `canStartSheetSkip` allows it (`:356`, `lib/swipe-to-skip.ts:46-51`),
  and always starts the vertical `bodySwipe` (`:357`).
- `bodySwipe` is a `createVerticalSwipe` (`now-playing.component.ts:248-291`) whose mode is decided
  once by `resolveBodyMode` (`:360-374`):
  - Up: `resize` below `lg` while `queueExtraHeightPx < QUEUE_EXTRA_MAX_PX`, otherwise `release`
    (`:366-371`). The origin zone is not consulted for up-swipes.
  - Down from the panel zone with a scrolled nested list: `release` (`:372`, via
    `scrollableAncestorTop`, `lib/vertical-swipe.ts:128-137`).
  - Down otherwise: `resize` if the panel is grown and not at `lg`, else `dismiss` (`:373`).
- **Continuation**: a collapse that runs out of panel flips to `dismiss` mid-gesture. It sets the
  extra to 0, **writes 0 to storage during the drag** and rebases the dismiss offset
  (`:264-268`).
- **Flick versus distance**: only `dismiss` uses velocity, through `shouldCommit(offset, velocity,
  {thresholdPx: 120})` (`:283-285`, `DISMISS_THRESHOLD_PX` at `:243`, `shouldCommit` at
  `lib/vertical-swipe.ts:113-121`, `FLICK_PX_PER_MS = 0.5` over `FLICK_WINDOW_MS = 100` at `:28-30`).
  A `resize` ignores velocity and persists wherever the finger stopped (`:276-278`).
- **pointercancel** is finished exactly like pointerup: `onCancel: (e, start) => finish(e, start)`
  (`lib/vertical-swipe.ts:226`, `finish` at `:239-254`). So a cancelled owned dismiss can still
  commit and close the sheet (`now-playing.component.ts:283-288`). The mini bar documents this as
  intentional for its open gesture ("Commit happens on end AND cancel",
  `components/player/player.component.ts:1805-1806`). The sheet has no comment either way.
- Mode table as documented: `docs/web-ui.md:98-106`.

### 1.2 Panel size is cover shrink, not a translating panel

- `queueExtraHeightPx` is "px the cover has shrunk", clamped to `[0, 320]`
  (`now-playing.component.ts:380-391`, `:520-522`). It drives `coverMaxPx = 320 − extra`
  (`:410-412`). It is persisted to `nicotind:np-queue-extra` (`:390`, read `:524-531`, written
  `:533-539`).
- The panel itself has no position. It is the flex remainder under the cover and transport, and its
  wrapper is `contents` below `lg` (`now-playing.component.html:129-133`).
- The notch is `role="separator"` with **no `tabindex`, no value and no key handler**
  (`now-playing.component.html:90-101`). There is no keyboard path to resize the panel. The `lg`
  splitter, by contrast, is focusable and keyboard operable (`:109-122`,
  `now-playing.component.ts:475-487`).

### 1.3 Tabs

- `activePanel: 'queue' | 'lyrics'` is persisted to `nicotind:np-active-panel`
  (`now-playing.component.ts:394-395`, read `:541-548`, written in `setActivePanel` `:550-560`).
  `lyricsOpen` is derived from it (`:407`).
- `NowPlayingPanelTabsComponent` takes two hard-coded buttons with `aria-pressed`, not
  `role="tab"` (`now-playing-panel-tabs/now-playing-panel-tabs.component.html:39-84`). Its types are
  the literal `'queue' | 'lyrics'` union (`now-playing-panel-tabs.component.ts:26-30`). **Tapping a
  tab only switches the panel. It never changes the size** (`:33-36`, `now-playing.component.ts:550`).
- The panel body is an `@if / @else` on `activePanel()` (`now-playing.component.html:141-158`).
- Q and Y reach the panel through `PlayerService.nowPlayingPanelRequest`
  (`services/player.service.ts:202`, `:783-786`, consumed at `now-playing.component.ts:582-589`).

### 1.4 Karaoke is a second "big panel" code path

- `karaokeFullscreen = signal(false)` (`now-playing.component.ts:185`) is never persisted.
- When the flag is set, the template hides the notch, splitter, tabs and panel
  (`now-playing.component.html:82`, `:105`). It mounts `app-now-playing-karaoke-fullscreen` as a
  **sibling overlay** (`:163-197`), which is `fixed inset-0 z-[70]` with `tabindex="-1"`
  (`now-playing-karaoke-fullscreen.component.html:1-4`). The cover and transport stay mounted under
  it. (`docs/web-ui.md:309-310` describes this as an `@if/@else` that replaces the tabbed area,
  which is not quite what the template does.)
- It is entered from the lyrics panel's corner button (`now-playing-lyrics-panel.component.html:2-12`)
  through `toggleKaraokeFullscreen` (`now-playing.component.ts:660-673`). That method forces the
  Lyrics tab, re-extracts colours and focuses the overlay on a `setTimeout`.
- It is exited by its ✕ (`karaoke html:44-54`), by leaving the Lyrics tab (`setActivePanel`,
  `now-playing.component.ts:554`), or by Back/Esc (the back-stack closer, `:568-572`).
- The auto-scroll fork: `resolveLyricsScrollContainer(karaokeFullscreen, refs)`
  (`lib/lyrics-scroll-container.ts:13-18`, used at `now-playing.component.ts:637-646`) picks the
  panel's `#lyricsScroll` or the overlay's browse list. It exists because the JIT harness cannot
  resolve `viewChild` (`docs/web-ui.md:330-334`).
- Vocal mute exists **only** in the karaoke overlay (`karaoke html:76-99`) and the `M` shortcut
  (`services/keyboard-shortcuts.service.ts:94`). The offset nudge exists in both the lyrics panel
  (`now-playing-lyrics-panel.component.html:38+`) and the overlay (`karaoke html:255-300`), and both
  are gated on `canSync`.
- The overlay's lyrics body calls `interaction.emit()` on **every** `touchmove`
  (`karaoke html:111-115`). That enters browse mode, so any future drag gesture on it would also
  flip it into browse.
- **The overlay component is shared with TV.** `TvKaraokeComponent` mounts the same
  `app-now-playing-karaoke-fullscreen` (`pages/tv/tv-karaoke.component.ts:38`, vocal mute at `:61`).
  Its `seekBar` and `canSync` inputs exist for the TV (`now-playing-karaoke-fullscreen.component.ts:42-64`).
  Folding karaoke in cannot delete that component.

### 1.5 `lg`, TV, motion

- `lg` is `matchMedia('(min-width: 1024px)')` (`now-playing.component.ts:60-63`). Up-swipes release
  and down-swipes dismiss there (`:368`, `:373`). The side column width is its own persisted state,
  `nicotind:np-side-width` (`:448-518`).
- **TV never mounts this sheet.** The route tree forks on `isTvBuild()` (`app.routes.ts:93-115`). The
  TV shell has its own `player` route (`app.routes.ts:284-314`) with its own karaoke overlay
  (`pages/tv/tv-player.component.html:172-173`) and queue overlay (`:177`). The sheet's in-component
  TV branch (`isTv = isTvUi()`, `now-playing.component.ts:417`, Next-up chip and `tvQueueOpen` at
  `now-playing.component.html:22-45`) renders only when e2e stamps `tv-build` on the **phone** bundle
  (`docs/tv-ux.md:464-469`).
- **Reduced motion is not honoured by the sheet.** `styles.css` gates only the mosaic,
  `.panel-enter` and `.menu-sheet-enter` (`packages/web/src/styles.css:671`, `:784`, `:816`). The
  sheet's `duration-300` transform (`now-playing.component.html:13`) and the karaoke `animate-pulse`
  orbs (`karaoke html:22-38`) always animate.

## 2. The model

### 2.1 State

```ts
// Proposed: lib/player-panel.ts (pure, no Angular)
type PanelSnap = 'rest' | 'full'; // D1 = C: no 'hidden'
interface PanelState {
  snap: PanelSnap;
  tab: string; // a registered tab id (§4)
}
```

The sheet's own open/closed state stays where it is (`PlayerService.nowPlayingOpen`,
`services/player.service.ts:200`). The panel machine runs only while the sheet is open, below `lg`,
and off TV. "Dismiss" is an **exit** of the panel machine into the sheet's state, not a fourth snap.

| Snap     | Panel                                                                 | Cover               | Transport                       |
| -------- | --------------------------------------------------------------------- | ------------------- | ------------------------------- |
| `rest`   | today's layout with `queueExtraHeightPx = 0`                           | max                 | visible                         |
| `full`   | top edge just under the safe-area inset; notch at its top; covers the cover, transport and header | covered | compact strip or tab's own (D6) |

**Two fixed snaps** (D3 A under D1 C). Today's free cover shrink becomes the visual
interpolation between `rest` and `full` while the finger is down: the first 320 px of lift shrink the
cover exactly as `coverMaxPx` does today, and the rest translate the panel up over the transport and
header. The panel never comes to rest in between.

### 2.2 Geometry: one scalar

A gesture works on one number, `lift`, in px. It is 0 at `rest`, positive upward, and negative
downward. It is measured once at resolve time from the live layout (**assumption**: one
`getBoundingClientRect` per gesture is cheap enough; no ResizeObserver).

- `lift(full) = F` = distance from the panel's rest top to `env(safe-area-inset-top)`.
- `lift < 0` is a dismiss drag: sheet offset `= −lift`. It is reachable only from a gesture that
  started at `rest` (D2 A). A gesture that started at `full` clamps `lift` at 0, so a hard collapse
  never closes the player. This is today's `dismissBaseDy` idea generalised.

Render mapping, all pure (`panelLayout(lift, geometry)`):

| `lift` range | `coverMaxPx`     | panel `translateY` | header/transport                          |
| ------------ | ---------------- | ------------------ | ----------------------------------------- |
| `< 0`        | 320              | 0 (sheet moves)    | normal; the whole sheet follows the finger |
| `[0, 320]`   | `320 − lift`     | 0                  | normal                                    |
| `(320, F]`   | 0                | `−(lift − 320)`    | covered; fade with progress (motion-safe) |

### 2.3 Transition table

Events: `drag-end(lift, velocity)`, `cancel(lift)`, `tap-active-tab`, `tap-tab(id)`, `notch-activate`,
`key-up`, `key-down`, `back`, `restore`. The geometry gap is `G = F` (rest→full).
`SNAP_COMMIT = min(96 px, 35 % of G)`. 96 is the mini bar's `OPEN_THRESHOLD_PX`
(`components/player/player.component.ts:1807`). `FLICK` is the existing `FLICK_PX_PER_MS`.
`start` is the snap the gesture began on.

| Start  | Event                         | Condition                                     | To                       |
| ------ | ----------------------------- | --------------------------------------------- | ------------------------ |
| `rest` | drag-end, `lift ≥ 0`          | `lift ≥ SNAP_COMMIT` or up-flick              | `full`                   |
| `rest` | drag-end, `lift ≥ 0`          | otherwise                                     | `rest`                   |
| `rest` | drag-end, `lift < 0`          | `shouldCommit(−lift, v, {thresholdPx: 120})`  | **exit: dismiss sheet**  |
| `rest` | drag-end, `lift < 0`          | otherwise                                     | `rest`                   |
| `full` | drag-end                      | `F − lift ≥ SNAP_COMMIT` or down-flick        | `rest` (never a dismiss) |
| `full` | drag-end                      | otherwise                                     | `full`                   |
| any    | cancel                        | same rows with `velocity = 0`                 | per distance only        |
| `rest` | tap-active-tab / notch-activate | —                                           | `full`                   |
| `full` | tap-active-tab / notch-activate | —                                           | `rest`                   |
| any    | tap-tab(id ≠ active)          | —                                             | same snap, `tab = id`    |
| any    | key-up / key-down             | —                                             | `full` / `rest` (no dismiss from a key) |
| `full` | back                          | —                                             | `rest` (consumed)        |
| `rest` | back                          | —                                             | not consumed → sheet closes |
| —      | restore                       | §8                                            | persisted snap and tab   |

A flick advances **at most one snap from where the gesture started**. A distance release settles on
the start snap or its neighbour in the direction of travel, so a fling from `full` lands on `rest`,
not into a dismiss. That one rule replaces "projected position" maths and is trivially
table-testable.

### 2.4 Who owns a pull (the new mode table)

`resolve` still runs once at slop (`lib/vertical-swipe.ts:176-183`). It now returns `panel`,
`dismiss` or `release`, decided by `(origin zone, direction, snap, nested scrollTop, lg)`.
Decided D2 option A:

| Origin                    | Direction | Snap              | Condition                         | Mode                     |
| ------------------------- | --------- | ----------------- | --------------------------------- | ------------------------ |
| any                       | any       | any               | `lg` (side column)                | today's rows: up releases, down dismisses (§5) |
| panel                     | down      | any               | nested `scrollTop > 0`            | release                  |
| panel                     | up        | `full`            | —                                 | release (native scroll)  |
| panel                     | up        | `rest`            | —                                 | **panel**                |
| panel                     | down      | `rest`, `full`    | at top                            | **panel** (from `rest` it continues into a dismiss; from `full` it stops at `rest`) |
| stage (cover, transport, header) | up | `rest`           | —                                 | **panel**                |
| stage                     | down      | `rest`            | —                                 | **dismiss** (today's cheap 120 px close is kept) |
| stage                     | any       | `full`            | —                                 | not reachable: the stage is covered |

What changes against `docs/web-ui.md:98-106`:

- **`resize` becomes `panel`** and covers both directions and both snaps. "Panel grown" rows
  disappear, because there is no grown-but-resting state.
- **New: `panel + up + full` releases.** At full height the list should scroll. Today an up-swipe on
  the panel resizes first whenever there is room (`now-playing.component.ts:366-371`).
- **Kept:** the nested-scroller yield, `BODY_NO_SWIPE`, queue rows owning their pointer through
  `data-np-no-swipe` (`now-playing-queue-panel.component.html:37`, #1295), and the swipe-skip
  arbitration (`createHorizontalSwipe` and the per-pointer claim, `lib/vertical-swipe.ts:160-183`).
  Skip stays excluded from the panel zone (`lib/swipe-to-skip.ts:42-51`); with D1 C there is no
  peek strip to add to it.
- **Continuation** stays as one uninterrupted pull, but it is now positional. From `rest`, `lift`
  runs below 0 into today's dismiss. From `full`, it clamps at `rest` (D2 A). Nothing is written to storage
  mid-gesture: the write at `now-playing.component.ts:266` goes, and persistence happens only on a
  settled snap.
- **pointercancel** settles by distance only (velocity forced to 0). An OS interruption, such as a
  call or a system edge gesture, then never flings the panel or closes the sheet. The mini bar's
  commit-on-cancel open (`player.component.ts:1805-1806`) is a different gesture and is left alone.
- **Interrupted gestures**: a new pointerdown during a settle animation starts from the *rendered*
  `lift`, read from the current transform, not from the target snap. That keeps "catch it
  mid-flight" from jumping (**assumption**: settle is a CSS transition, so the rendered value is
  read with `getComputedStyle`).

## 3. Karaoke folds in

Decided D5 option A: **Karaoke is the Lyrics tab at `full`.**

| Today                                                  | Proposed                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `karaokeFullscreen` signal (`now-playing.component.ts:185`) | deleted; `karaokeActive = computed(() => snap() === 'full' && tab() === 'lyrics')` for the few readers left (colour extraction, the back stack) |
| `toggleKaraokeFullscreen` (`:660-673`)                  | deleted; the lyrics corner button becomes "expand" and emits `notch-activate` |
| gesture off under karaoke (`:350`)                      | the guard is deleted. A pull-down on the follow view (no scroller) goes `full → rest`; the browse list yields while `scrollTop > 0` |
| sibling overlay `fixed inset-0 z-[70]` (`karaoke html:4`) | rendered **inside** the panel's `full` frame. The component keeps its inputs and outputs for TV; positioning moves to a host class each mount sets (TV keeps `fixed inset-0`) |
| `resolveLyricsScrollContainer` fork (`lib/lyrics-scroll-container.ts`) | moves into the Lyrics tab as its `scrollContainer(snap)` answer. The auto-scroll effect (`now-playing.component.ts:637-646`) moves into the tab, so no child ref has to cross a component boundary |
| `touchmove` → browse (`karaoke html:113-114`)           | browse enters on `wheel`, on the swipe's `onRelease` (the finger went to native scroll) and on the keyboard toggle — **not** on a touchmove the panel gesture owns |
| Back: exit karaoke, then close (`:568-578`)             | Back: `full → rest`, then close. Same order for every tab |
| leaving Lyrics exits karaoke (`:554`)                   | by construction: `tap-tab(queue)` keeps `full` but shows the queue at full height |
| focus the overlay on entry (`:671`)                     | on entering `full` (any tab), focus moves to the notch; on leaving it, focus returns to the control that asked (tab, notch or expand button) |
| vocal mute: overlay only                                | unchanged: part of the karaoke `full` view's own chrome (`chrome: 'own'`, §4). `M` is untouched |
| offset nudge: panel and overlay                         | unchanged in both views; `canSync` gating as today |
| TV `TvKaraokeComponent` (`pages/tv/tv-karaoke.component.ts:38`) | unchanged; it keeps mounting the same presentational component |

The cover-colour effect (`now-playing.component.ts:624-629`) already gates on `lyricsOpen`, so the
gradient is ready before `full` is reached.

## 4. Tab registration contract

A tab is data. The shell renders tabs, the frame, the notch and the gesture. A tab renders its body
and answers two questions.

```ts
// Proposed: components/now-playing/player-panel-tabs.ts
export interface PlayerPanelTab {
  id: string;                  // persisted (§8); never reused for a different tab
  icon: IconName;              // #1668: icon always, label on the active tab
  labelKey: string;            // i18n key
  testid: string;              // keeps now-playing-tab-queue / -lyrics stable
  badge?: (ctx: PanelTabContext) => number | boolean | null; // queue count, lyrics dot
  body: Type<unknown>;         // rendered at rest and full
  full?: {
    body?: Type<unknown>;      // a different view at full (Lyrics → karaoke); default: `body`
    chrome: 'compact-transport' | 'own'; // D6
    atLg: boolean;             // whether `full` exists beside the side column (§5)
  };
}
export const PLAYER_PANEL_TABS = new InjectionToken<readonly PlayerPanelTab[]>('PLAYER_PANEL_TABS');
```

The body receives `snap` as an input. **Rules a tab must follow to need no gesture code:**

1. Exactly one vertical scroller, `overflow-y-auto overflow-x-hidden`, inside the
   `[data-np-zone="panel"]` frame. `scrollableAncestorTop` finds it with no registration
   (`lib/vertical-swipe.ts:128-137`), and the both-axes rule applies (`docs/web-ui.md:2202`).
2. Any element with its own horizontal or long-press gesture carries `data-np-no-swipe`, as queue
   rows do.
3. No `pointerdown` listener of its own that moves vertically.
4. A tab that auto-scrolls does so itself, from inputs (`activeLine`), not through a shell
   `viewChild`.

Adding a tab is one array entry plus its component. A sweep spec asserts every registered tab's body
template obeys rules 1 and 2. The tab strip itself becomes #1668's `<app-icon-tabs variant="tabs">`
(`role="tablist"`, `aria-selected`), replacing the `aria-pressed` buttons
(`now-playing-panel-tabs.component.html:44`, `:66`). The badge slot is #1668's step 2.

## 5. `lg`

- The side column stays. There is no vertical `panel` mode at `lg`, so today's two
  `lg` rows are kept verbatim (`now-playing.component.ts:368`, `:373`), and so are the splitter and
  `nicotind:np-side-width`.
- The machine still runs, with snaps `{rest, full}` only. `rest` is the side column. `full` exists
  only for tabs whose `full.atLg` is true: Lyrics/karaoke yes, as today, since karaoke covers the
  sheet at every width (`docs/web-ui.md:422`); Queue no (a full-width queue on a desktop buys
  nothing). Tapping the active Queue tab at `lg` is then a no-op.
- The persisted snap is shared across widths. A `full` for a tab without `atLg` renders as `rest`. The stored value is not rewritten, so the phone
  layout returns as left (`matchMedia` is read live, `:60-63`).

## 6. TV, desktop pointer and keyboard

- **TV: no change.** The machine is not instantiated on TV. The real TV player is a route
  (`app.routes.ts:284-314`) with its own queue and karaoke overlays
  (`pages/tv/tv-player.component.html:172-177`). The sheet's `isTvUi()` branch is dead on a real TV
  build (§1.5). **Proposed follow-up, separate issue:** delete it and `now-playing-tv.spec.ts` rather
  than teach the new machine about it.
- **Mouse** gets the same gesture for free. `createVerticalSwipe` is pointer-events based, and CI
  already drives the sheet with `page.mouse` (`docs/web-ui.md:113-116`). No wheel-to-resize: a wheel
  over the panel scrolls it.
- **Keyboard** (new, because today there is none for the panel, §1.2). The notch becomes
  `<div role="button" tabindex="0" aria-expanded aria-controls>`. It is a `div`, not a `button`,
  because `BODY_NO_SWIPE` excludes `button`, which would kill the drag. The queue handle sets the
  precedent (`docs/web-ui.md:139-141`).
  - Enter/Space: `notch-activate`.
  - ArrowUp/ArrowDown: `key-up`/`key-down`.
  - Esc and hardware Back go through the existing back stack (§2.3 `back` rows).
  - Q and Y keep meaning "open on this tab" and follow the tab-tap rule (D4) when the sheet is
    already open on that tab.
  - None of these fire from a text field (`isTextEntryTarget`, `docs/web-ui.md:2424-2425`).
- The splitter keeps its keys.

## 7. Accessibility

- **Focus order** follows DOM order, which matches visual order: header → cover/track info →
  transport → notch → tabs → panel body. At `full` the covered stage (header, cover, transport) gets
  `inert`, so Tab cannot land behind the panel. Snap changes move focus as in §3.
- **ARIA**: the notch has `aria-expanded = snap === 'full'` and `aria-controls` pointing at the panel
  frame, with its label switching "Expand queue/lyrics" ↔ "Collapse". The tabs are
  `tablist`/`tab`/`tabpanel` via #1668. The frame carries `aria-label` from the active tab. No live
  region: `aria-expanded` already announces the change.
- **Reduced motion**: settle transitions become `motion-reduce:transition-none` (an instant snap),
  the header/transport fade at `full` is skipped, and the karaoke orbs become `motion-safe:animate-pulse`.
  The finger-following drag stays, because direct manipulation is not decorative motion. The same
  applies to the sheet's existing `duration-300` (`now-playing.component.html:13`), which fixes the
  gap from §1.5 in passing.
- **Targets**: the notch stays at least 44 px (`docs/web-ui.md:2290-2300`).

## 8. Persistence migration

New key `nicotind:np-panel`, JSON `{"v":1,"tab":"queue","snap":"rest"}`. It is read once at
construction, as the two old keys are today.

| Read                                   | Result                                                          |
| -------------------------------------- | --------------------------------------------------------------- |
| `np-panel` valid, tab registered       | use it                                                          |
| `np-panel` valid, tab not registered   | first registered tab, same snap                                 |
| `np-panel` with an unknown snap (e.g. `hidden`) | `rest`, same tab                                       |
| `np-panel` malformed or `v` unknown    | fall through to the legacy keys                                 |
| legacy `nicotind:np-active-panel`      | `'lyrics'` → `tab: 'lyrics'`, anything else → `'queue'` (as `:541-548`) |
| legacy `nicotind:np-queue-extra`       | any value → `snap: 'rest'` under D3 A (see below)               |
| none                                   | `{tab: 'queue', snap: 'rest'}`                                  |

After a legacy read, the new key is written and **then** both legacy keys are removed, in that
order, so a failed write leaves the old state readable. Storage errors are swallowed, as today.
`nicotind:np-side-width` is untouched.

`np-queue-extra` maps to `rest`, not `full`, even for someone who had dragged it to 320. `full`
covers the transport, which their old layout never did, and `full` is one tap away.

`full` is persisted and restored, karaoke included. Nothing jumps on load, because the sheet itself
always boots closed (`services/player.service.ts:200`). The next open lands where the listener left
it. Today `karaokeFullscreen` is not restored, so this is new behaviour, and the reload e2e in #1681
asserts it.

## 9. Tests (maps to the sub-issues)

- **#1678, unit, pure, table-driven** (`lib/player-panel.spec.ts`):
  - every row of §2.3 and §2.4;
  - flick against distance on each side of `SNAP_COMMIT`;
  - one-snap-max on a hard fling (a fling down from `full` lands on `rest`, never a dismiss);
  - continuation from `rest` into a dismiss, and its absence from `full` (D2);
  - `cancel` with velocity 0;
  - interrupted settle starting from the rendered `lift`;
  - `lg` reduction;
  - the persistence table in §8, including the legacy key removal order.
- **#1679, component**: the `panelLayout` mapping bound to `coverMaxPx` and the frame transform;
  notch ARIA and keys; `inert` per snap; the queue at `full` releasing up-swipes to native scroll.
  **e2e (CDP touch, as `mobile-ux.spec.ts:1097`)**: pull-up to full, tap active tab, pull-down to
  rest, over-pull from rest into a dismiss, reload resume, swipe-skip and dismiss side by side with no stolen
  pointer, and a queue-row swipe still owning its pointer.
- **#1680**: karaoke entered and exited through the notch, the tab and a pull; browse mode not
  entered by an owned pull; vocal mute and offset present at `full`; TV karaoke spec unchanged.
- **#1681**: the sweep spec for tab rules 1 and 2; a fake third tab registered in a spec and driven
  through every snap with zero gesture code; Storybook stories per snap × tab (`rest`, `full`,
  karaoke), extending `now-playing.stories.ts`.

## Decisions

Answered by the owner on 2026-11-09: **D1 C, D2 A, D3 A, D4 A, D5 A, D6 A**. The options are kept
below as the record of what was weighed. D3 A's "three fixed snaps" became two because D1 C removed
`hidden`.

**D1. When the panel is pulled off scene, what is left on screen?**
- **A (recommended):** a 44 px peek strip with the notch and the tab icons, because without one
  nothing tells the listener the panel can come back. Tap or pull it to return to `rest`.
- B: nothing. The panel comes back only from an up-pull anywhere on the stage or from the keyboard.
  This is cleaner but undiscoverable.
- C (keep current): no `hidden` state, and "further down" keeps meaning "dismiss the sheet", as
  today's continuation does.

**D2. Which pull closes the whole player?**
- **A (recommended):** the origin decides. A down-pull on the stage (cover, transport, header)
  dismisses in 120 px, as today. A down-pull on the panel moves the panel, and only a pull that
  *started* at `rest` or `hidden` continues past off-scene into a dismiss. A hard collapse from
  `full` then never closes the player by accident.
- B: everything goes through the panel. The sheet closes only past `hidden`. This is one chain, but
  closing from `rest` costs a panel's height plus 120 px.
- C (keep current): any collapse that runs out continues into a dismiss, from any start snap.

**D3. Does the panel still rest at in-between heights?**
- **A (recommended):** no. Three fixed snaps (`hidden`, `rest`, `full`); the cover shrink is only
  the animation between them. This is the simplest machine to test, and it matches the three states
  the owner named.
- B: keep a user-sized `rest`. The 0–320 px band settles wherever it is released, as now, and
  `full`/`hidden` sit beyond it. `np-queue-extra` keeps its meaning, but every release rule needs an
  in-band exception.
- C: four fixed snaps, adding `expanded` (cover gone, transport visible), as #1651's body listed.

**D4. What does tapping a tab do?**
- **A (recommended):** an inactive tab switches and keeps the current snap (`hidden` becomes
  `rest`). The active tab toggles `rest` ↔ `full`. Q and Y follow the same rule.
- B: any tab tap goes straight to `full`. This is the most literal reading of "tapping Queue
  expands it", but switching tabs at rest becomes impossible.
- C (keep current): a tap only switches, and only a pull or the notch expands.

**D5. What is karaoke in the new system?**
- **A (recommended):** the Lyrics tab at `full`. The `karaokeFullscreen` flag, the disabled gesture
  and the scroll-container fork all disappear, and TV keeps the same presentational component.
- B: a third tab, "Karaoke", with `rest` showing the 2-line view. This adds a tab that duplicates
  Lyrics at rest.
- C: keep the overlay, but route its enter, exit and Back through the machine. This is the least
  code, but it keeps two "big panel" paths, which is what #1651 asked to remove.

**D6. What stays visible above a `full` panel?**
- **A (recommended):** a compact transport strip (title, play/pause, next) for tabs declaring
  `chrome: 'compact-transport'` (Queue). Tabs declaring `'own'` (karaoke) bring their own controls.
  Without the strip, a full queue on a short phone loses play/pause, which today's max resize never
  did.
- B: nothing but the notch and tabs. The panel is the whole screen, and you pull down for controls.

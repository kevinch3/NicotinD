# Theme audit — every surface × the 7 presets (2026-11)

The audit step of the visual refresh (#1662, sub-issue #1682), and the evidence the palette
proposal (#1683) builds on. It records **where the palette is flat today**, measures contrast for
the current tokens, and ends with the closed questions the owner answers before any token changes.
Nothing here changes code or tokens.

**Already decided (owner, 2026-11-07), not re-asked:** keep the seven presets and widen the
default's range. The blur and stacking contract (#1649) is settled in
[design-patterns.md](design-patterns.md) ("Blur and stacking contract"). A restyle keeps to it.

## How the screenshots were taken

- **Harness**: a throwaway Playwright `*.screens.ts` flow on the same managed-server, fixture-library
  setup as `playwright.screenshots.config.ts` ([e2e.md](e2e.md) "Screenshot flows"). It seeds synced
  LRC lyrics on the fixture album so karaoke renders timed lines. For TV it used a throwaway
  `*.tvbuild.spec.ts` on the `tv` project, which serves the real `--configuration tv` bundle at
  960×540 ([e2e.md](e2e.md) "The TV bundle in Chromium"). Neither file is committed. Each surface is
  loaded once and then shot seven times by swapping `data-theme` on `<html>`, so every preset shows
  the same DOM state.
- **Viewports**: phone 390×844, desktop 1280×800 and TV 960×540, all at DPR 1 to keep files small.
- **Output**: [`measurements/theme-audit-2026-11/`](measurements/theme-audit-2026-11/), WebP at
  q70, 4.8 MB in total. `sheets/` holds one contact sheet per surface and viewport with all seven
  presets side by side. That is the reading format: compare across a row. `phone/`, `desktop/` and
  `tv/` hold the individual frames, named `<NN-surface>--<preset>.webp`.

| Viewport | Surfaces (× 7 presets) | Frames |
| --- | --- | --- |
| phone | home (mosaic), home (shelves), Library, album, artist, Search, Get/Downloads, Settings, Admin, album while playing (mini player), Now Playing, karaoke | 84 |
| desktop | the same 12 | 84 |
| TV | home, browse, album, player, settings | 35 |

**What was trimmed, and why**

- **TV is a subset**: 5 of its screens. The queue overlay, the device picker and the TV karaoke
  have midnight baselines under `tests/tv-build/*-snapshots/`, and they use the same fixed-dark
  player backdrop as the player frame.
- **No tablet or landscape frames.** The layouts are the phone and desktop ones at another width,
  and neither changes a colour role.
- **Empty states on Get, Search and Downloads.** The fixture server has no acquisition addon, so
  Search shows "no sources" and Downloads shows an empty feed. The populated rows
  (`download-item`, the source chips) are audited from their templates, not from pixels.
- **Settings and Admin collapsed.** That is the real default state. The expanded bodies are
  covered by `settings-gallery.screens.ts`.
- **No modals, sheets or menus**: track-info, entity menu, confirm. They inherit `bg-theme-surface`
  plus `--theme-elevation-overlay` and add no colour role of their own.
- **Artwork**: the fixture album has one dark, noisy cover. Every other tile is the generated
  placeholder. This turned out to be informative: see "the accent doing every job" below.

## Where today's palette stands (facts)

In this section and below, a `styles.css` path means `packages/web/src/styles.css`, and every
other path is relative to `packages/web/src/app/`.

- **One token set per preset**: `styles.css:46-215`. The same 20 tokens each time:
  `bg/surface/surface-2/hover/border`, three text levels, one accent (`accent`, `accent-text`,
  `on-accent`), highlight, and four status pairs.
- **Elevation already exists** (`styles.css:238-268`, #1638): `--theme-elevation-tile/-raised/
  -overlay/-up`, plus `--theme-glass-edge` and `--theme-glass-alpha`. In templates it is used only
  by the mosaic tiles, `.glass-panel` (`styles.css:751-755`) and the mini player. There are 57 raw
  Tailwind `shadow*` uses beside it.
- **The only non-accent hues in the product**: the eight vibe gradients
  (`lib/vibe-presets.ts:42-91`) and three source-chip tones (`styles.css:313-325`, mixed into the
  surface with `color-mix`).
- **Counts** (regex over non-spec, non-story `packages/web/src/app` `.html`/`.ts`):
  - 214 `theme-accent*` references, against 390 `bg-theme-surface`, 281 `bg-theme-surface-2` and
    only 22 `bg-theme-base`.
  - 157 `status-*` uses.
  - 231 raw `bg/text/border/divide/placeholder/ring-zinc-N` classes. The issue's "~112" counted
    differently: this number counts every class, so some lines count more than once.
  - Raw hue classes: 53 red, 34 emerald, 15 blue, 14 rose, 14 amber, and fewer of the rest.
  - Radius: 311 `rounded-lg`, 200 `rounded`, 158 `rounded-full`, 88 `rounded-xl`, 34 `rounded-md`
    and 11 `rounded-2xl`. That is six radii with no stated rule for which goes where.

## The three kinds of flatness

### 1. No hierarchy between surface levels

The surface step table further down measures it. **`bg → surface` is 1.03:1 on Warm Paper, about
1.10 on Daylight and Forest, and 1.06 on OLED.** Those steps are below what reads as a separate
plane at a glance. Then the templates flatten what little step there is:

- **The persistent chrome is page-coloured.** The header is `bg-theme-base` with a border
  (`components/layout/layout.component.ts:83`). The Now Playing sheet is `bg-theme-base`
  (`components/now-playing/now-playing.component.html:12`). Only the tab bar
  (`components/bottom-nav/bottom-nav.component.html:3`) and the mini player (`.player-chrome`,
  `styles.css:829-835`) sit on `surface`. On desktop, header, page and player bar read as one plane
  (`sheets/desktop-10-album-playing.webp`).
- **Cards halve the step.** `SettingsGroupComponent` is `bg-theme-surface/50`
  (`components/settings-group/settings-group.component.html:2`). The card's shape on Settings,
  Admin and Extensions is therefore carried by its border alone. On OLED the cards are close to
  invisible (`sheets/phone-09-admin.webp`).
- **`border` equals `surface-2` on all five dark presets** (for example `styles.css:49` and `:51`).
  Any bordered control on `surface-2` loses its border.
- **Lists have no container.** Track rows (`components/track-row/`) and the Now Playing queue sit
  straight on `bg`. The playing row differs only by accent text and the eq bars (`styles.css:987`).
- **Every secondary action has the same weight.** On an album, Select, Download, Share and Fix
  metadata are all `bg-theme-surface-2 text-theme-muted`
  (`pages/library/album-detail.component.html:47-74`). Muted text on `surface-2` is also the
  lowest-contrast pair the system has (about 4.53:1 on every preset).

### 2. The accent doing every job

One hue says "press me", "you are here", "this is playing", "this is a link", "this is a category
icon", "this has no cover" and "this is a count":

- Primary fills: play buttons and count badges
  (`components/bottom-nav/bottom-nav.component.html:27`).
- The active nav item, the seek fill, and the playing row's title and eq bars.
- **Every category icon chip**: `bg-theme-accent/15 text-theme-accent-text` on the settings
  headers (`components/settings-group-header/settings-group-header.component.html:3`), the import
  tiles (`pages/get/get.component.html:78`, `components/import-entry/import-entry.component.html:9`,
  `components/import-drop-card/import-drop-card.component.html:7`), the Now Playing tabs
  (`components/now-playing/now-playing-panel-tabs/now-playing-panel-tabs.component.html:9-35`) and the radio chip
  (`components/now-playing/radio-chip/radio-chip.component.html:3`). There are 13 such tint sites. Every
  Admin group gets the same accent square (`sheets/phone-09-admin.webp`).
- **Every coverless artwork.** `placeholderGradient` is `linear-gradient(var(--theme-accent),
  var(--theme-surface-2))` (`components/cover-art/cover-art.component.ts:28-30`). A library with
  sparse artwork becomes a wall of accent tiles: on the mosaic and the TV home, the tiles change
  hue with the preset while the vibe tiles beside them do not (`sheets/phone-01-home.webp`,
  `sheets/tv-01-home.webp`).
- **Midnight and Daylight have the same accent**, `#6164f1` (`styles.css:55`, `:79`). The
  `theme-color` meta table in `services/theme.service.ts:26-34` still says `#6366f1`, a small
  drift from the token.

### 3. Status colours reused as decoration, or shown at rest

- **A destructive action is red at rest.** "Remove album" is `text-status-error` before anyone
  touches it (`pages/library/album-detail.component.html:78`). It is the only coloured text on the
  album page apart from the accent.
- **A state toggle uses "done" green.** A downloaded genre fills its button with `status-done`
  (`pages/library/genre-detail.component.html:22`). The extension "configured" badge
  (`pages/plugins/plugin-card.component.html:120`) and Admin's "Live" label
  (`pages/admin/system-health/system-health-panel.component.html:147`) are green labels too.
  Green therefore means "finished", "on", "installed" and "connected", depending on where it
  appears.
- **The `@theme` status colours are the text colour.** `bg-status-*` is registered from
  `--theme-status-*-text` (`styles.css:411-415`), so `bg-status-error/15` tints with pink on dark
  presets and dark red on light ones. That is a decoration tint, not the paired, contrast-checked
  `.status-*` pill (`styles.css:331-334`).
- **Hardcoded hues outside the token system**: `text-red-400`/`text-red-500` in the Search errors
  (`pages/search/search.component.html:125-148`), the login error
  (`pages/login/login.component.html:141`) and the curate cards
  (`pages/curate/case-card.component.html:25`, `:47`), and the emerald source dot
  (`pages/search/search.component.html:97`).

### Holdouts that break a preset rather than flatten it

These are for the migration slice (#1685), not the palette:

- **Search's input is fixed-dark.** It is `bg-zinc-900 … text-zinc-100`
  (`pages/search/search.component.html:15`), so on Daylight and Warm Paper a black slab sits on a
  light page (`sheets/phone-06-search.webp`).
- **Search's empty state is illegible on every dark preset.** It uses `text-zinc-600` and
  `text-zinc-700` (`pages/search/search.component.html:1171-1172`), which measure 1.61 to 2.57:1 on
  Midnight, OLED, Twilight and Forest.
- **Karaoke and the TV player ignore the preset by design.** Both are cover-driven dark surfaces
  (`lib/cover-colors.ts:16-20` holds `DEFAULT_PALETTE`; `pages/tv/tv-player.component.html:5-11`).
  The TV shell's status line is `text-theme-muted` (`components/tv-shell/tv-shell.component.ts:36-37`).
  Over the fixed-dark player backdrop on Daylight, Warm Paper and E-Ink, it turns dark grey on
  dark (`sheets/tv-04-player.webp`). Phone karaoke on E-Ink also renders a dark gradient with a
  grey next line. That is flagged for the E-Ink owner, and the E-Ink rules stay as they are.

## Per surface

The sheet for each row is `measurements/theme-audit-2026-11/sheets/<viewport>-<NN-surface>.webp`.

| Surface | Where it is flat | Tokens and classes |
| --- | --- | --- |
| Home, mosaic (`01`) | Coverless tiles are accent gradients, so the field is one hue plus the eight fixed vibe hues. The view switch is the only chrome. | `cover-art.component.ts:28-30`; `lib/vibe-presets.ts:42-91` |
| Home, shelves (`02`) | Shelf headers and cards sit on `bg` with no section surface. Colour comes only from the vibe tiles and the accent placeholders. | `radio-landing` shelves; `placeholderGradient` |
| Library (`03`) | The grid sits on `bg`. The find bar and the tab strip are both plain `surface-2`, the only level used above the page. | `library.component.html:15`, `:90` |
| Album (`04`, `10`) | The header is page-coloured. Four secondary buttons look identical (muted on `surface-2`). "Remove album" is red at rest. The playing row is accent text only. | `album-detail.component.html:47-78`; `layout.component.ts:83` |
| Artist (`05`) | The about box is `bg-theme-surface/30`, nearly invisible. The active tab is an accent underline, and links are accent text. | `artist-detail.component.html:117`, `:186`, `:238` |
| Search (`06`) | Fixed-dark input on light presets. The empty state is illegible on dark presets. | `search.component.html:15`, `:1171-1172` |
| Get / Downloads (`07`) | Tabs are `surface-2` on `bg`, the import tile is an accent chip, and a status pill is the only other colour. | `get.component.html:19`, `:78` |
| Settings (`08`) | Cards are `surface/50` plus a border, each with an accent icon chip: three identical rows. | `settings-group.component.html:2`; `settings-group-header.component.html:3` |
| Admin (`09`) | One identical accent chip per half-surface card, and close to no card on OLED. | the same |
| Now Playing (`11`) | The whole sheet is `bg`. The cover is the only colour, and it does not reach the surface. The queue and lyrics tabs are accent tints. | `now-playing.component.html:12`; `now-playing-panel-tabs.component.html` |
| Karaoke (`12`) | Cover-derived and preset-blind (intended). Only the seek fill is the accent. On Daylight the unplayed track is white on a dark gradient. | `now-playing-karaoke-fullscreen.component.html:4-5` |
| TV home, browse, album | Same placeholder issue at 10 ft. Buttons are `surface-2` pills with nothing to rank them. | `pages/tv/*` |
| TV player | Fixed-dark backdrop. The status line disappears on light presets. | `tv-shell.component.ts:36-37` |

## Contrast for today's tokens

Computed from `styles.css` by a small script: WCAG 2.x relative luminance. An `rgba` status or
highlight background is first composited over the preset's `surface` (where pills sit), and any
other translucent token over `bg`. ✗ marks a pair under its target: 4.5:1 for text, 3:1 for the
accent used as a non-text UI fill. E-Ink keeps its own rules (darker secondary, muted and border,
a 500 weight floor and thicker strokes), and its row is shown for completeness.

| Pair | Target | midnight | daylight | warm-paper | oled | twilight | forest | eink |
|---|---|---|---|---|---|---|---|---|
| text-primary on bg | 4.5 | 18.10 | 16.12 | 14.09 | 21.00 | 14.05 | 15.69 | 21.00 |
| text-primary on surface-2 | 4.5 | 13.55 | 13.96 | 11.31 | 17.40 | 9.53 | 10.32 | 15.91 |
| text-secondary on bg | 4.5 | 7.76 | 7.03 | 7.09 | 8.33 | 6.64 | 6.79 | 21.00 |
| text-secondary on surface | 4.5 | 6.91 | 7.73 | 7.29 | 7.85 | 5.68 | 6.18 | 19.26 |
| text-secondary on surface-2 | 4.5 | 5.81 | 6.09 | 5.69 | 6.90 | 4.51 | 4.47 ✗ | 15.91 |
| text-muted on bg | 4.5 | 6.05 | 5.26 | 5.67 | 5.46 | 6.67 | 6.89 | 12.63 |
| text-muted on surface | 4.5 | 5.38 | 5.78 | 5.83 | 5.15 | 5.71 | 6.27 | 11.59 |
| text-muted on surface-2 | 4.5 | 4.53 | 4.55 | 4.55 | 4.53 | 4.52 | 4.53 | 9.57 |
| accent-text on bg | 4.5 | 6.07 | 5.26 | 5.67 | 7.04 | 6.66 | 9.56 | 21.00 |
| accent-text on surface | 4.5 | 5.40 | 5.78 | 5.84 | 6.64 | 5.69 | 8.69 | 19.26 |
| accent-text on surface-2 | 4.5 | 4.54 | 4.55 | 4.55 | 5.83 | 4.51 | 6.29 | 15.91 |
| on-accent on accent | 4.5 | 4.56 | 4.56 | 4.91 | 6.64 | 6.17 | 10.20 | 21.00 |
| accent (UI fill) on bg | 3 | 4.36 | 4.15 | 2.96 ✗ | 7.04 | 6.17 | 9.56 | 21.00 |
| highlight-text on highlight-bg | 4.5 | 7.64 | 7.28 | 6.29 | 8.15 | 7.11 | 7.63 | 21.00 |
| status-progress pill | 4.5 | 7.40 | 5.49 | 6.37 | 8.15 | 7.66 | 7.52 | 11.82 |
| status-done pill | 4.5 | 8.82 | 6.49 | 6.78 | 10.62 | 6.49 | 10.62 | 8.80 |
| status-warn pill | 4.5 | 9.28 | 6.37 | 7.66 | 10.39 | 8.39 | 11.74 | 9.25 |
| status-error pill | 4.5 | 7.06 | 6.80 | 6.80 | 8.51 | 8.51 | 8.51 | 7.24 |
| status-error text on bg | 4.5 | 10.48 | 7.56 | 7.72 | 11.06 | 8.84 | 9.37 | 10.01 |

**Surface steps.** Each cell gives the contrast ratio, then the OKLCH lightness difference ×100.
The ratio is what WCAG measures. ΔL is closer to what the eye sees as "a different plane".

| Step | midnight | daylight | warm-paper | oled | twilight | forest | eink |
|---|---|---|---|---|---|---|---|
| bg → surface | 1.12 / 7.0 | 1.10 / 3.3 | 1.03 / 1.0 | 1.06 / 14.5 | 1.17 / 5.4 | 1.10 / 3.8 | 1.09 / 3.0 |
| surface → surface-2 | 1.19 / 6.4 | 1.27 / 8.0 | 1.28 / 8.2 | 1.14 / 7.3 | 1.26 / 6.4 | 1.38 / 9.3 | 1.21 / 6.3 |
| bg → surface-2 | 1.34 / 13.3 | 1.15 / 4.8 | 1.25 / 7.3 | 1.21 / 21.8 | 1.47 / 11.8 | 1.52 / 13.1 | 1.32 / 9.3 |
| bg → border | 1.34 / 13.3 | 1.34 / 9.6 | 1.52 / 13.5 | 1.21 / 21.8 | 1.47 / 11.8 | 1.52 / 13.1 | 7.46 / 55.0 |
| surface → border | 1.19 / 6.4 | 1.48 / 12.9 | 1.57 / 14.4 | 1.14 / 7.3 | 1.26 / 6.4 | 1.38 / 9.3 | 6.84 / 52.1 |

**What the tables say**

- **Two real failures.** Forest's secondary text on `surface-2` is 4.47:1. Warm Paper's accent as
  a fill on `bg` is 2.96:1 against the 3:1 non-text target. The play button stays identifiable,
  because `on-accent` on the fill is 4.91:1.
- **Muted text and accent text are tuned to the floor on `surface-2`**: 4.51 to 4.55 on six
  presets. That is the hidden constraint on widening the range. Any lighter surface level breaks
  them unless the text levels move with it, so the proposal has to move them together.
- **Warm Paper has no `bg → surface` step** (1.03), and Daylight's `bg → surface-2` (1.15) is
  smaller than its `surface → surface-2` (1.27). On the light presets the "raised" level is darker
  than the page and the "base" level is lighter, so the order is not monotonic.

## Decisions for the owner

One decision per question. The recommended option comes first, and "keep current" is always
offered.

**Q1 — Secondary accent: which job should a second hue take over from the accent?**
- **A. "Now playing / live" (recommended).** Radio chip, playing row, eq bars, seek fill and the
  Now Playing tabs move to a warm second hue, for example coral on Midnight. The primary accent
  keeps "press me" and "you are here". This splits the jobs the audit found most often conflated
  (13 tint sites plus the playing state), and the play button stays the one primary fill.
- **B. Decoration only.** Category icon chips, placeholders and section marks take the second hue.
  Every state stays on the primary. This is lower risk, but it puts colour where meaning is not.
- **C. No second hue, a tonal accent ramp instead.** `accent-subtle`, `accent` and `accent-strong`
  so the chips take a quieter step. It keeps the most minimal look but adds the least range.
- **D. Keep current**: one accent for everything.

**Q2 — Entity colours: should artists, albums, playlists, radios and genres get a colour identity?**
- **A. Only where there is no artwork (recommended).** Coverless placeholders and genre tiles take
  a deterministic hue from one fixed set of about 8, like the vibe gradients already in
  `lib/vibe-presets.ts`, instead of the accent. Entities with art stay neutral. This removes the
  "wall of accent" without inventing a colour language people have to learn.
- **B. One hue per entity type** (artist, album, playlist, radio) on icons, chips and links. This is
  strong wayfinding, but it adds four hues to a minimal UI and competes with the cover art.
- **C. Keep current**: everything neutral plus the accent.

**Q3 — Cover-derived tint: should artwork colour reach surfaces beyond karaoke?**
- **A. Now Playing and the mini player only (recommended).** A low-alpha wash of the cover's
  dominant colour on the sheet's top band and on the mini player. It is clamped so that text keeps
  4.5:1 and is off on E-Ink. The extractor already exists and runs for karaoke
  (`lib/cover-colors.ts`), and the sheet is the flattest full-screen surface (`bg` only).
- **B. A, plus album and artist headers**: a hero wash behind the cover. This gives more range on
  the two most-visited pages, but every page changes colour with its artwork.
- **C. A cover-derived accent while playing**, replacing the accent on the player (the Spotify and
  Apple Music pattern). This has the widest range, but contrast has to be computed per cover at
  runtime.
- **D. Keep current**: karaoke and the TV player backdrop only.

**Q4 — Elevation and radius: how should surface levels separate?**
- **A. Tonal steps first, shadows only for floating layers (recommended).** Widen
  `bg → surface → surface-2`, add a `surface-3`, and use the existing elevation tokens only on what
  floats (tiles, menus, sheets, the mini player). The radius keeps today's scale but gains one
  written rule: `rounded-lg` for controls, `rounded-xl` for cards, `rounded-full` for pills. This
  fixes the measured failure (Warm Paper's 1.03 step) without changing the minimal character.
- **B. Soft shadows on cards and rows too**, mostly on the light presets, radius unchanged. Cards
  read as cards even with small tonal steps, but the look gets busier.
- **C. A, plus one radius bump**: cards to `rounded-2xl`, controls to `rounded-xl`. This is a
  visibly softer look, and it touches about 400 call sites.
- **D. Keep current**: today's steps and six radii without a rule.

**Q5 — Default neutrals: should Midnight and Daylight pick up a hint of their accent hue?**
- **A. A slight indigo tint (recommended).** OKLCH chroma of about 0.01 to 0.02 toward the accent.
  Twilight and Forest do this much more strongly, and in the sheets they read as the "richest"
  presets for exactly that reason.
- **B. Keep current**: pure zinc neutrals, with only the lightness steps widened (per Q4).

## Draft palette direction (pending answers)

**Draft.** It assumes the recommended answer to every question above, and it changes if any answer
differs. It covers Midnight and Daylight only. The other five presets follow the same mapping in
#1683. It is a sketch for #1683 and #1684, not a token change. The old names stay as aliases
(#1684 slice a), so nothing regresses on day one.

| Old token | New token | Midnight now → draft | Daylight now → draft | Note |
| --- | --- | --- | --- | --- |
| `--theme-bg` | `--theme-bg` | `#09090b` → `#0a0a0f` | `#f4f4f5` → `#ececf1` | slight tint (Q5); Daylight's page gets darker so that cards rise |
| `--theme-surface` | `--theme-surface-1` (alias kept) | `#18181b` → `#18181f` | `#ffffff` → `#ffffff` | cards, tab bar, mini player, the header (moved off `bg`) |
| `--theme-surface-2` | `--theme-surface-2` | `#27272a` → `#25252f` | `#e4e4e7` → `#e0e0e8` | controls, inputs, chips |
| — | `--theme-surface-3` (new) | → `#31313d` | → `#d3d3dd` | hover and pressed; no accent text on it |
| `--theme-border` | `--theme-border` (no longer equal to surface-2) | `#27272a` → `#3a3a46` | `#d4d4d8` → `#c0c0cc` | 1.35:1 against surface-2, so borders on controls show again |
| `--theme-text-secondary` | unchanged name | `#a1a1aa` → `#a8a8b4` | `#52525b` → `#4b4b56` | moves with the wider ramp |
| `--theme-text-muted` | unchanged name | `#8d8d96` → `#9a9aa6` | `#65656d` → `#585863` | ≥ 4.6:1 up to surface-3 |
| `--theme-accent` | `--theme-accent` | `#6164f1` (kept) | `#6164f1` → `#5457e8` | Daylight's accent separates from Midnight's |
| `--theme-accent-text` | unchanged name | `#7f82f4` → `#8a8cf7` | `#4b4eef` → `#4245dc` | |
| — | `--theme-accent-2`, `-2-text`, `on-accent-2` (new, Q1) | → `#f0806a` / `#f39a87` / `#1a0b07` | → `#c2410c` / `#a3360a` / `#ffffff` | "now playing / live" |
| — | `--theme-hue-1…8` (new, Q2) | the vibe gradient end colours, mixed into the surface the way `.chip-tone-*` are | the same | placeholders and genre tiles |
| — | `--theme-cover-wash` (runtime, Q3) | set from `loadCoverPalette` on the sheet | the same | `none` on E-Ink |
| `--theme-elevation-*` | unchanged | — | — | used only on floating layers (Q4) |

**Contrast of the draft** (same method as above):

- **Midnight**:
  - steps: `bg → s1` 1.12, `s1 → s2` 1.16, `s2 → s3` 1.18, against today's single `bg → s2` 1.34.
    The range now spans four levels.
  - muted text: 7.10, 6.35, 5.45 and 4.61 on bg, s1, s2 and s3.
  - accent-text: 5.18 on s2.
  - accent-2-text: ≥ 5.98 everywhere. `on-accent-2` on its fill: 7.31.
- **Daylight**:
  - steps: `bg → s1` 1.18 (today 1.10) and `s1 → s2` 1.31.
  - muted text: ≥ 4.72 on every level.
  - accent-2-text: 5.18 on s2. `on-accent` on the new accent: 5.38.
  - The accent-2 fill on `bg` (4.40) clears the 3:1 non-text target.

Warm Paper's 1.03 step and its 2.96 accent fill, and Forest's 4.47 secondary text, are fixed in the
same pass under #1683.

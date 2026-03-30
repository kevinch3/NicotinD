# UI/UX Overhaul — Design Spec

**Date:** 2026-03-29
**Status:** Approved for implementation planning

---

## Context

Users reported that NicotinD's interface is too dark, text is illegible, and the app feels like three disconnected tools. The biggest pain point is the gap between *finding music* (Search) and *actually playing it* — users download something and don't know where it went or how to play it without visiting a separate Downloads page. Additionally, the app has no theme options, which has caused accessibility complaints, especially from users reading on e-ink or light-background devices.

**Goals:**
1. Make the track lifecycle feel continuous: Search → download → play without leaving the page.
2. Introduce a proper theme system with 6 presets so users aren't locked into a dark background.
3. Improve legibility, spacing consistency, and album art prominence across all pages.

**Priority order:** UX simplification first, theme system second, spacing/polish third.

---

## 1. Track Lifecycle — Inline Download Progress

### Problem
After clicking Download in Search, users must navigate to `/downloads` to check progress, then go to `/library` to play. Three separate pages for one logical action.

### Solution: Inline status states on Search result cards

Each track card in Search results gains a visual state machine driven by `useTransferStore`:

**State 1 — Default (not started)**
- Button: `↓ Download` (current style, unchanged)
- Shows: filename, codec, bitrate, file size, username (already present)

**State 2 — In progress**
- Background: blue translucent wash (`bg-blue-900/20`) fills the card left→right proportional to `%` complete
- Button becomes: `↓ 63%` (blue variant, already defined in `BUTTON_CLASSES.progress`)
- No extra chrome — the card itself communicates progress

**State 3 — Completed**
- Background: green translucent wash (`bg-green-900/15`) covers full card width
- Two actions replace the single button:
  - `▶ Play now` — calls `usePlayerStore.play(track)` directly, streams immediately
  - `+ Queue` — appends to current queue without interrupting playback
- Both buttons stay rendered until the user navigates away or the search resets

### What changes
- `Search.tsx`: map `useTransferStore.getStatus(key)` to card visual state
- `TrackRow.tsx` (if reused in Search): accept `transferStatus` prop for progress overlay
- Library auto-refresh: in `useTransferStore`, when a transfer transitions to `Completed`, set a `libraryDirty` flag. `Library.tsx` reads this flag on mount/focus and calls `api.getAlbums()` to refresh — so Library is ready when the user visits without a manual reload

### What does NOT change
- Downloads page still exists as a full audit log — it just stops being *required*
- The `DownloadIndicator` badge in the header remains (global count signal)

---

## 2. Thumbnail Prominence

Album art is the primary visual anchor for music identity. It must be reliable and prominent everywhere.

### Rules
- **Search result cards**: Thumbnail slot always rendered (36×36px). If no art available, show a deterministic color block (same gradient logic as Playlists) based on `hash(artist + album)` — never a blank grey square.
- **Player bar**: Thumbnail always 40×40px (desktop), 32×32px (mobile). Same fallback color block.
- **Library grid**: Album covers 160×160px minimum. Fallback: large gradient block with artist initial.
- **NowPlaying overlay**: Full-width cover art, same fallback.
- **Preserve/queue indicators**: Thumbnail shown in toasts/confirmations when referencing a track.

### Implementation
Add a `<CoverArt>` component (`components/CoverArt.tsx`) that:
- Accepts `src?`, `artist`, `album`, `size`
- Renders `<img>` when `src` is valid, with `onError` fallback
- Fallback: deterministic gradient div using `hashCode(artist + album) % gradients.length`
- Replaces all ad-hoc `bg-zinc-800` cover placeholders

---

## 3. Theme System

### Architecture

**CSS custom properties** are the foundation. All color values move from hardcoded Tailwind classes to CSS variables. Tailwind v4 supports `@theme` blocks with custom properties natively.

**Token structure** in `src/index.css` — plain CSS custom properties, no Tailwind-specific syntax required:

```css
@layer base {
  :root {
    /* Midnight (default — matches current hardcoded values) */
    --color-bg-base: #09090b;
    --color-bg-surface: #18181b;
    /* ... all tokens */
  }
  [data-theme="daylight"] {
    --color-bg-base: #f4f4f5;
    --color-bg-surface: #ffffff;
    /* ... */
  }
  /* remaining 4 themes follow same pattern */
}
```

**Token categories:**

| Token | Purpose |
|---|---|
| `--color-bg-base` | Page background |
| `--color-bg-surface` | Card/component background |
| `--color-bg-hover` | Hover state background |
| `--color-border` | Borders and dividers |
| `--color-text-primary` | Main readable text |
| `--color-text-secondary` | Secondary/metadata text |
| `--color-text-muted` | Placeholders, disabled |
| `--color-accent` | Interactive accent (buttons, active nav) |
| `--color-status-progress-bg` / `-text` | In-progress download |
| `--color-status-done-bg` / `-text` | Completed download |
| `--color-status-error-bg` / `-text` | Failed download |

**System preference:** On load, detect `prefers-color-scheme`. If `systemTheme` is enabled in settings, map `light` → Daylight, `dark` → Midnight.

### Theme Context

New file: `src/stores/theme.ts`
```ts
type ThemeId = 'midnight' | 'daylight' | 'warm-paper' | 'oled' | 'twilight' | 'forest'
interface ThemeStore {
  theme: ThemeId
  systemTheme: boolean
  setTheme(id: ThemeId): void
  setSystemTheme(on: boolean): void
}
```

Implemented as a Zustand store (consistent with all other stores). Persisted to localStorage. On mount, applies `document.documentElement.setAttribute('data-theme', theme)`.

### The 6 Presets

| ID | Name | Base BG | Surface | Primary text | Accent |
|---|---|---|---|---|---|
| `midnight` | Midnight | `#09090b` | `#18181b` | `#f4f4f5` | `#6366f1` |
| `daylight` | Daylight | `#f4f4f5` | `#ffffff` | `#18181b` | `#6366f1` |
| `warm-paper` | Warm Paper | `#faf6f0` | `#fff9f0` | `#292524` | `#d97706` |
| `oled` | OLED Black | `#000000` | `#0a0a0a` | `#ffffff` | `#818cf8` |
| `twilight` | Twilight | `#1e1b2e` | `#2d2640` | `#ede9f6` | `#a78bfa` |
| `forest` | Forest | `#0f1a17` | `#172320` | `#e2f5ed` | `#2dd4bf` |

### Settings UI

In `Settings.tsx`, new "Appearance" section:
1. **Follow system theme** — toggle (Zustand `systemTheme`). When ON: swatch grid is dimmed and non-interactive.
2. **Theme preset** — 3-column swatch grid (only active when system preference OFF). Each swatch: small preview of nav + rows in that palette + name label. Tap to switch instantly.

---

## 4. Legibility & Spacing

### Text contrast fixes
- All `text-zinc-600` on dark backgrounds → `text-zinc-400` minimum (meets WCAG AA 4.5:1)
- Track metadata (`text-[11px]`, `text-[10px]`) → minimum `text-xs` (12px). Sub-12px text only for badges with sufficient contrast.
- Download stats line in Search cards: bump from `text-[10px]` to `text-xs`

### Spacing consistency
Current state: ad-hoc Tailwind values scattered per-component. Standardise on:
- **Component inner padding:** `px-3 py-2` (small cards), `px-4 py-3` (sections)
- **Page container:** `max-w-6xl mx-auto px-4 py-5 md:px-6 md:py-8` (uniform across all pages)
- **Stack gap between cards:** `gap-2` (track rows), `gap-3` (album grid tiles)
- **Section breathing room:** `mb-6` between major page sections

### Player height
Currently `h-16 md:h-18` (conflicting). Fix: `h-16` everywhere, `pb-16` on main content. Single source of truth.

---

## 5. Component Refactoring

To support themes without duplication, the following refactors are needed:

| What | Where | Why |
|---|---|---|
| `<CoverArt>` component | new `components/CoverArt.tsx` | Centralise art + fallback logic |
| `useThemeStore` | new `stores/theme.ts` | Theme state + persistence |
| CSS token definitions | `src/index.css` | `data-theme` attribute variants |
| Replace `bg-zinc-*` / `text-zinc-*` hardcoded classes | All components | Use `bg-[var(--color-bg-surface)]` etc. |
| `BUTTON_CLASSES` in `downloadStatus.ts` | Update to use CSS vars | Status colors adapt to theme |

### Phasing
Components can be migrated to CSS variables incrementally. The `data-theme` attribute approach means un-migrated components stay visually correct in Midnight (the default matches current hardcoded values) while new/migrated components gain full theme support.

---

## 6. Files to Create / Modify

**New files:**
- `src/stores/theme.ts` — Zustand theme store
- `src/components/CoverArt.tsx` — Cover art with fallback

**Modified files:**
- `src/index.css` — Add CSS custom property token system
- `packages/web/index.html` — Remove hardcoded `dark` class; theme applied via JS on mount
- `src/App.tsx` — Mount theme store, apply `data-theme` to `<html>`
- `src/pages/Search.tsx` — Inline download progress states on track cards
- `src/pages/Settings.tsx` — Appearance section with system toggle + swatch grid
- `src/components/Layout.tsx` — Use CSS variable classes
- `src/components/Player.tsx` — Use `<CoverArt>`, fix player height, use CSS variable classes
- `src/components/TrackRow.tsx` — Use `<CoverArt>`, spacing fixes, CSS variable classes
- `src/lib/downloadStatus.ts` — Update `BUTTON_CLASSES` to CSS variable references
- `src/pages/Library.tsx` — Use `<CoverArt>`, spacing fixes
- `src/pages/Downloads.tsx` — Spacing fixes, text size fixes

---

## 7. Verification

- **Theme switching:** Toggle each of the 6 presets in Settings → entire app re-renders in new palette. Reload → same theme restored.
- **System preference:** Enable "Follow system theme" toggle → change OS theme → app switches automatically without page reload.
- **Inline progress:** Start a download from Search → card shows blue wash + % counter without visiting Downloads page → on completion, "▶ Play now" appears → click → track plays immediately.
- **Legibility:** Open app in Daylight theme on a bright monitor → all text readable without squinting. Check metadata lines at zoom 100%.
- **Cover art fallback:** Remove/break a cover art URL → CoverArt component shows deterministic gradient, not broken image icon.
- **Player height:** No content is hidden behind the player bar on any page.

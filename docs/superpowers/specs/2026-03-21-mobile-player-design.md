# Mobile UI + Player Features Design Spec

## Context

NicotinD's web UI has a working player with basic play/pause, progress bar, seek, and auto-play-next. The navigation is desktop-oriented (horizontal top bar). This spec adds full player transport controls (shuffle, queue, next/prev, repeat), a now-playing slide-up panel, and responsive mobile navigation.

## Scope

1. **Enhanced Player Store** — shuffle, repeat, previous, play context
2. **Player Bar Redesign** — prev/next/shuffle/repeat controls
3. **Now Playing Panel** — slide-up panel with queue list
4. **Mobile Navigation** — hamburger menu on small screens

No new dependencies. All built with existing stack: React 19, Zustand, Tailwind 4, React Router 7.

---

## 1. Enhanced Player Store

**File:** `packages/web/src/stores/player.ts`

### New State

```typescript
interface PlayContext {
  type: 'album' | 'playlist' | 'adhoc';
  id?: string;           // album/playlist ID (undefined for adhoc)
  name?: string;         // display name
  originalOrder: Track[]; // for unshuffle
}

interface PlayerState {
  // Existing
  currentTrack: Track | null;
  isPlaying: boolean;
  queue: Track[];

  // New
  history: Track[];           // previously played tracks (for prev)
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  context: PlayContext | null;
  nowPlayingOpen: boolean;    // slide-up panel visibility

  // Existing actions
  play: (track: Track) => void;
  pause: () => void;
  resume: () => void;
  addToQueue: (track: Track) => void;
  playNext: () => void;
  clear: () => void;

  // New actions
  playPrev: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  playWithContext: (tracks: Track[], startIndex: number, context?: Omit<PlayContext, 'originalOrder'>) => void;
  removeFromQueue: (index: number) => void;
  setNowPlayingOpen: (open: boolean) => void;
}
```

### Behavior Details

**`playWithContext(tracks, startIndex, context?)`**
- Sets `currentTrack` to `tracks[startIndex]`
- Sets `queue` to `tracks.slice(startIndex + 1)`
- Stores `context` with `originalOrder: tracks`
- Clears `history`
- If shuffle is on, randomizes the queue immediately

**`playNext()`** (updated)
- Pushes `currentTrack` onto `history`
- If `repeat === 'one'`: replay current track (don't shift queue)
- If queue has items: shift first item to `currentTrack`
- If queue is empty and `repeat === 'all'`: reload from `context.originalOrder` (shuffled if shuffle is on), play first
- If queue is empty and `repeat === 'off'`: stop playback

**`playPrev()`**
- If audio is >3 seconds in: restart current track (handled in Player component by resetting `audio.currentTime`)
- If history has items: unshift `currentTrack` back to front of `queue`, pop from `history` to `currentTrack`
- If no history: restart current track

**`toggleShuffle()`**
- Toggles `shuffle` boolean
- If turning ON: randomize remaining `queue`, save current order in `context.originalOrder`
- If turning OFF: restore queue to original order relative to current track position

**`cycleRepeat()`**
- Cycles: `'off'` → `'all'` → `'one'` → `'off'`

**`play(track)`** (updated)
- If called directly (not via context), pushes `currentTrack` to `history` before replacing

---

## 2. Player Bar Redesign

**File:** `packages/web/src/components/Player.tsx`

### Layout (desktop, md+)

```
┌─────────────────────────────────────────────────────┐
│ [cover] Title    🔀  ⏮  ▶⏸  ⏭  🔁     vol?      │
│          Artist     ──●──────── 1:23/3:45           │
└─────────────────────────────────────────────────────┘
```

- **Left (w-60):** Cover art (40px) + title + artist (clickable to open panel)
- **Center (flex-1):** Transport controls row + progress bar below
  - Shuffle button (dimmed when off, emerald when on)
  - Previous button
  - Play/Pause button (existing circle style)
  - Next button
  - Repeat button (dimmed when off, emerald for 'all', shows "1" badge for 'one')
- **Right (w-60):** Reserved for future volume control (empty spacer for now)

### Layout (mobile, <md)

```
┌─────────────────────────────────┐
│ [cover] Title…  ⏮  ▶⏸  ⏭     │
│          Artist  ───●────────── │
└─────────────────────────────────┘
```

- Track info area shrinks (no fixed width)
- Shuffle/Repeat buttons hidden (available in Now Playing panel)
- Right spacer removed
- Entire bar is tappable (outside buttons) to open Now Playing panel

### Click Behavior

- Clicking track info area or empty space opens Now Playing panel
- Buttons (play, pause, prev, next) perform their action without opening the panel

---

## 3. Now Playing Slide-Up Panel

**File:** `packages/web/src/components/NowPlaying.tsx` (new)

### Structure

```
┌──────────────────────────────────┐
│  ▼ (chevron down to collapse)    │  <- drag handle / close button
│                                  │
│       ┌──────────────┐           │
│       │              │           │
│       │  Cover Art   │           │  <- large cover, ~60% width, centered
│       │  (rounded)   │           │
│       │              │           │
│       └──────────────┘           │
│                                  │
│     Song Title                   │  <- text-xl, centered
│     Artist Name                  │  <- text-sm text-zinc-400, centered
│                                  │
│  ──────────●──────────────       │  <- full-width seek bar
│  1:23                    3:45    │
│                                  │
│     🔀   ⏮   ▶⏸   ⏭   🔁      │  <- full transport controls
│                                  │
│  ─── Next up ────────────────    │  <- divider
│                                  │
│  1. Track Name - Artist          │  <- scrollable queue list
│  2. Track Name - Artist          │
│  3. Track Name - Artist          │
│  ...                             │
└──────────────────────────────────┘
```

### Behavior

- Opens via `nowPlayingOpen` state in player store
- Renders as a fixed overlay, `z-60`, animated from `translate-y-full` to `translate-y-0`
- Background: `bg-zinc-950` (matches app theme)
- Chevron-down button at top to close
- Queue list is scrollable, shows track number, title, artist
- Tapping a queue item jumps to that track
- On mobile: full viewport height. On desktop: could be capped at 80vh with rounded top corners (nice-to-have).

---

## 4. Mobile Navigation

**File:** `packages/web/src/components/Layout.tsx` (modified)

### Desktop (md+)

No changes — existing horizontal nav bar.

### Mobile (<md)

- **Header:** Logo "NicotinD" + hamburger icon (☰) on the right + DownloadIndicator
- **Nav links hidden** via `hidden md:flex` on the nav element
- **Hamburger opens drawer:** Fixed overlay from left, `z-50`, contains:
  - All nav items as vertical links (full-width, larger touch targets)
  - Username + Sign out at bottom
  - Semi-transparent backdrop overlay to close on tap

### State

- Simple `useState<boolean>` in Layout component for drawer open/close
- No new store needed — purely local UI state
- Drawer closes on route change (listen to location via `useLocation`)

---

## Files Modified

| File | Change |
|------|--------|
| `packages/web/src/stores/player.ts` | Add shuffle, repeat, history, context, nowPlayingOpen, new actions |
| `packages/web/src/components/Player.tsx` | Add prev/next/shuffle/repeat buttons, responsive layout, panel trigger |
| `packages/web/src/components/NowPlaying.tsx` | **New** — slide-up panel with queue list |
| `packages/web/src/components/Layout.tsx` | Add hamburger menu for mobile, responsive nav |

## Files Unchanged

- API routes, stores (auth, search), other pages — no backend changes needed
- All player data (streaming, cover art) already works via existing endpoints

---

## Verification

1. **Player controls:** Play an album from Library page → verify shuffle randomizes queue, repeat cycles modes, prev goes back, next advances
2. **Now Playing panel:** Tap player bar → panel slides up, shows queue, tap queue item jumps to it, chevron closes panel
3. **Mobile nav:** Resize browser to <768px → hamburger appears, drawer opens/closes, nav links work, drawer closes on navigation
4. **Repeat modes:** `one` loops same track, `all` restarts queue from context, `off` stops at end
5. **Shuffle restore:** Turn shuffle on (queue randomizes), turn off (queue restores to original order from current position)

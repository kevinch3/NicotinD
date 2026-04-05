# NicotinD UI/UX Overhaul — Phase 2 Design

**Date:** 2026-04-05
**Scope:** Downloads, Library, Playlists, and shared track row / search improvements

---

## 1. Downloads

### 1.1 Sort Order
- The "Recently Added" section defaults to **newest-first** (descending by `dateAdded`).
- Active Downloads grouping (by album/directory) is unchanged.

### 1.2 Playlist Autocomplete Picker
- Replaces the current flat dropdown list when adding tracks to a playlist.
- New shared component: `PlaylistAutocompleteComponent` (placed in `packages/web/src/app/components/playlist-autocomplete/`).
- Renders as a floating panel anchored to the trigger button.
- Contains a text input that filters playlists by name as the user types.
- Each result row shows:
  - Cover art (first track's art, or deterministic gradient fallback matching the existing `CoverArtComponent` pattern)
  - Playlist name
  - Artist hint: first 2 unique track artists, comma-separated
- A "Create new playlist" option appears at the bottom when no exact name match exists.
- Emits:
  - `selected: string` (playlist id) when an existing playlist is chosen
  - `create: string` (typed name) when "Create new" is selected
- Closes on outside click or Escape.

### 1.3 Album Group Actions
- Each album group in the Active Downloads section gets a **Remove album** button (trash icon in the group header).
- Clicking shows a confirmation dialog ("Remove all files in this album?") before executing.
- Individual track rows within album groups get the shared "..." context menu (see Section 4).

---

## 2. Library

### 2.1 Browse Mode Switcher
- The Library page header gains a pill/tab toggle: **Albums** | **Artists** | **Genre**.
- Default mode: Albums (existing behavior unchanged).
- Mode persists to `localStorage` key `nicotind-library-mode`.

### 2.2 Artists Mode
- Grid of artist cards: artist name + album count.
- Same grid density as the album grid (2 cols mobile, 5 cols desktop).
- Click → Artist detail view.

**Artist detail view:**
- Route: `/library/artists/:id`
- Shows artist name as heading.
- Lists all albums by that artist as cards (same `AlbumCard` component as Albums mode).
- Clicking an album card navigates to the existing album detail view.

**Artist links:**
- Album artist names in the Album detail view (track list header) become clickable links navigating to `/library/artists/:id`.

### 2.3 Genre Mode
- Grid of genre cards: genre name + track count.
- Click → flat track list filtered by that genre, using `TrackRowComponent`.
- Subsonic API already returns genre tags via `getGenres()` / song `genre` field — no backend changes needed.

### 2.4 Album & Track Removal
- Album detail view header gets a **Remove album** button (with confirmation dialog).
- Each track row in the album detail view gets the "..." context menu (see Section 4).
- "Remove" action in the menu shows a confirmation dialog ("Remove this track from library?") before executing.

---

## 3. Playlists

### 3.1 Playlist Name Editing
- A rename icon (pencil) or "Rename" option appears on the playlist detail header.
- Clicking opens a **modal dialog** with:
  - Text input pre-filled with the current playlist name.
  - Confirm button → calls `api.updatePlaylist(id, { name })`.
  - Cancel button → discards, closes modal.

### 3.2 Track Rows
- All track rows in playlists get the "..." context menu (see Section 4).
- "Remove from playlist" action requires confirmation dialog.

### 3.3 Search
- Search input is always visible at the top of the playlist detail view (not behind a toggle or button).
- Filters the track list live as the user types.
- Uses existing `ListControlsService` pattern.

### 3.4 Playlists List Sort
- The playlists index (list of all playlists) defaults sort to **newest-first** (descending by date created).

---

## 4. Shared Components & Patterns

### 4.1 Track Row "..." Context Menu

**`TrackRowComponent` change:**
- Adds an `actions` input: `Array<TrackAction>`.

```typescript
interface TrackAction {
  label: string;
  icon?: string;
  action: () => void;
  destructive?: boolean;
}
```

- A "..." (three-dot) button appears on the right side of every track row, always visible (not hover-only).
- Clicking opens a small dropdown panel anchored below/above the button depending on viewport space.
- Destructive actions render in red / `--color-danger` token.
- Panel closes on outside click or Escape key.

**Standard action set (each page passes only what applies):**

| Action | Available in |
|--------|-------------|
| Add to playlist | All views |
| Remove | Downloads, Library (album detail), Playlists |
| Go to artist | Library, Playlists, Search |
| Go to album | Playlists, Search |
| Details | All views — opens an info panel showing: title, artist, album, file path, format, bitrate, file size, duration |

**Confirmation:** All destructive actions (Remove) trigger a confirmation dialog before executing. The `destructive: true` flag on `TrackAction` marks these; the menu component itself does not handle confirmation — the `action` callback passed by the parent is responsible for showing the dialog.

### 4.2 `PlaylistAutocompleteComponent`
- Shared component in `components/playlist-autocomplete/`.
- Used by:
  - Downloads — "Add to playlist" in bulk action bar
  - "Add to playlist" action in the "..." menu across all views
- See Section 1.2 for full spec.

### 4.3 Search Always Visible
- All views with search (Downloads, Library, Playlists) render the search input **always visible** at the top of the page.
- No toggle button or collapsed state.
- Uses existing `ListToolbarComponent` — template changes only, no new component.

### 4.4 Confirmation Dialog
- A shared `ConfirmDialogComponent` (or reuse of any existing modal) is used for all destructive confirmations.
- Displays a message, a confirm button (red/danger style), and a cancel button.
- If a shared modal service already exists in the codebase, use it. Otherwise create a minimal `ConfirmDialogComponent`.

---

## 5. Routes

| New/Changed Route | Description |
|-------------------|-------------|
| `/library` | Existing — gains mode switcher (Albums/Artists/Genre) |
| `/library/artists/:id` | New — Artist detail view |

---

## 6. Out of Scope

- CLI changes
- Backend / API changes (all required endpoints already exist)
- Mobile app compatibility (Subsonic proxy unchanged)
- Offline caching changes (`PreserveService`)
- Genre editing / tag writing

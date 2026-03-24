# UX Enhancements Batch — 2026-03-24

Six items: two features, three enhancements, one bug fix. All scoped to the web UI (`packages/web`) with one new API endpoint and one new navidrome-client method.

---

## 1. Search Similar Tracks (Feature)

### Purpose

Context menu action on any track: "Find similar" queries the local Navidrome library for related songs using multi-signal metadata similarity.

### API

**New endpoint:** `GET /api/library/songs/:id/similar?size=20`

**New navidrome-client method:** `getSongsByGenre(genre, count, offset)` — wraps Subsonic `getSongsByGenre.view`.

### Similarity Scoring

Fetch the source song via `getSong(id)` to obtain `artist`, `artistId`, `genre`, `year`, `albumId`, `path`.

| Signal | Description | Score |
|--------|-------------|-------|
| Same artist | Other songs by same `artistId`, different albums | 10 |
| Same album | Other tracks from same `albumId` | 5 |
| Album-level artist overlap | Artists appearing on compilation/feature albums alongside the source artist | 7 |
| Same genre + year range | Songs sharing `genre` tag, ±5 years from source `year` | 3 |
| Path heuristic | Songs sharing a common parent folder prefix in `path` (e.g., both under `Jazz/`) | 4 |

**Query strategy:**

1. Fetch source song metadata
2. Fetch artist's albums (capped at 10 most recent to avoid excessive API calls for prolific artists) → collect all songs (tier 1: same artist)
3. Fetch source album's songs (tier 1: same album, lower score)
4. If genre present: `getSongsByGenre(genre, 200)` → filter ±5 years, exclude same artist → randomly sample up to 30 (tier 2). Higher fetch count ensures variety for popular genres; random sampling avoids bias toward Navidrome's default sort.
5. Path heuristic: compare source `path` directory components against tier 2 candidates, boost score for matches
6. Album overlap: from albums fetched in step 2, if any are compilations (multiple artists), pull other artists' songs as tier 1.5

**Performance:** Steps 2-3 are sequential (need artist albums first), but step 4 can run in parallel with steps 2-3 via `Promise.all`. Expected latency: ~1-2s for typical libraries. Frontend shows a loading spinner during the request.

**Result:** Dedupe by song ID, exclude source song, sort by total score descending, cap at `size`. Return as slim song objects `Array<{ id, title, artist, album, duration?, coverArt?, genre?, year? }>` (matching the local search results shape, not the full core `Song` type).

### Frontend

- Context menu item "Find similar" on all track rows (search local results, library, downloads recent songs, NowPlaying)
- Calls the API, navigates to Search page
- Displays results as a special "Similar to [song title]" section — local results only, no network search triggered
- New search store fields: `similarTo: { title: string; artist: string } | null`, `similarResults: Song[]`
- Search page renders `similarResults` when present, with a dismiss/clear action

### Files touched

| File | Change |
|------|--------|
| `packages/navidrome-client/src/api/browsing.ts` | Add `getSongsByGenre()` |
| `packages/api/src/routes/library.ts` | Add `GET /songs/:id/similar` endpoint |
| `packages/web/src/lib/api.ts` | Add `getSimilarSongs(id, size)` |
| `packages/web/src/stores/search.ts` | Add `similarTo`, `similarResults`, `setSimilar`, `clearSimilar` |
| `packages/web/src/pages/Search.tsx` | Render similar results section |
| `packages/web/src/components/TrackContextMenu.tsx` | New shared context menu component with "Find similar" and "Search more by artist" items (used by sections 1 and 2) |

---

## 2. Artist "Search More" + Quick Wins (Feature)

### Purpose

Shortcuts to prefill the search bar and auto-fire a search. Multiple trigger points across the app.

### Mechanism

**New custom hook:** `useNavigateAndSearch()` — returns a `(query: string) => void` function. Internally uses `useNavigate()` from React Router. Sets `useSearchStore.query` and `useSearchStore.autoSearch = true` via direct store access, then calls `navigate('/')`. Must be a hook (not a standalone function) because `useNavigate()` requires React Router context.

**Search page refactor:** Extract the core search logic from `handleSearch` into a standalone `executeSearch()` function that takes no arguments (reads query from the store). The form submit handler calls `e.preventDefault()` then `executeSearch()`. The auto-search `useEffect` watches `autoSearch` on mount, calls `executeSearch()` if true, and clears the flag. This fixes the signature mismatch where `handleSearch(e: React.FormEvent)` cannot be called without an event.

**New search store fields:** `autoSearch: boolean`, `setAutoSearch(v: boolean)`.

### Trigger Points

| Surface | Trigger | Query |
|---------|---------|-------|
| Any track row | Context menu: "Search more by artist" | Artist name |
| Any track row | Click/tap artist name text | Artist name |
| Any track row | Click/tap album name text | Album name |
| Local search artist results | Click artist name | Artist name |
| NowPlaying panel | Click/tap artist name | Artist name |
| NowPlaying panel | Click/tap album name (below title) | Album name |
| Folder view directory names | Click/tap directory basename | Directory basename text |
| Downloads recent songs | Click/tap artist name | Artist name |
| Search bar | Dropdown: last 5-10 recent searches | Selected query |

### Clickable Artist/Album Names

Wrap existing artist/album text in track rows with a `<button>` or `<span onClick>` that calls `navigateAndSearch(artistName)`. Style: subtle underline on hover, cursor pointer. No new UI components needed.

### Search History

- Store last 10 unique queries in `useSearchStore.history: string[]`
- Persist to `localStorage` manually (read on store init, write on update) — the codebase does not currently use Zustand `persist` middleware
- Render as a dropdown below the search input when focused and empty, or always below with recent label
- Each entry is clickable → sets query + auto-fires search
- Clear-all button in the dropdown

### Files touched

| File | Change |
|------|--------|
| `packages/web/src/stores/search.ts` | Add `autoSearch`, `history`, related setters |
| `packages/web/src/pages/Search.tsx` | Auto-search on mount, search history dropdown, clickable artist/album names in local results |
| `packages/web/src/components/Player.tsx` | Clickable artist name |
| `packages/web/src/components/NowPlaying.tsx` | Clickable artist + album names |
| `packages/web/src/pages/Downloads.tsx` | Clickable artist name in recent songs |
| `packages/web/src/hooks/useNavigateAndSearch.ts` | New custom hook (needs `useNavigate` from React Router context) |
| `packages/web/src/components/FolderBrowser.tsx` | Clickable directory basename in folder view (calls `navigateAndSearch`) |

---

## 3. Folder Browser Mobile Adaptation (Enhancement)

### Purpose

Replace the cramped two-panel layout on mobile with drill-down navigation. Fix "current folder not visible" on all viewports.

### Responsive detection

Render both layouts and use Tailwind responsive classes (`hidden md:flex` / `md:hidden`) to show/hide. The drill-down and tree are different DOM structures but share the same `selected` state, so toggling visibility is sufficient — no JS media query needed.

### Mobile (< md breakpoint)

**Breadcrumb bar:**
- Replaces tree panel
- Horizontally scrollable container with tappable path segments
- Auto-scrolls to rightmost segment on render
- Separator: `›` between segments
- Style: `text-xs text-zinc-400`, active segment `text-zinc-200`

**Single list view:**
- Subfolders rendered as tappable rows (folder icon + name + chevron `›`)
- Files listed below subfolders (same layout as current file list)
- Tapping a subfolder updates `selected` path and breadcrumb
- "Download all" button pinned in the header bar next to breadcrumb

**No separate back button** — breadcrumb segments handle upward navigation.

### Desktop (>= md breakpoint)

**No layout changes.** Keeps existing two-panel tree + file list.

**Fix: auto-scroll to current folder.** The `TreeNode` button element uses a conditional ref callback: when `selected === node.fullPath`, attach a ref that calls `el.scrollIntoView({ block: 'center', behavior: 'smooth' })` on first render. Use a `useEffect` with `[selected]` dependency to trigger scroll only when selection changes, avoiding re-scroll on every render.

### Files touched

| File | Change |
|------|--------|
| `packages/web/src/components/FolderBrowser.tsx` | Responsive layout: breadcrumb + drill-down on mobile, scroll-into-view fix on desktop |

---

## 4. Bug Fix: Folder Download State Bleeding (Bug)

### Problem

Downloading a folder in search results marks other folders from the same user as "Queued", blocking new downloads. Root cause needs investigation during implementation — two possible mechanisms: (a) filename key collisions across folders if browse API returns bare filenames, or (b) the `allOptimisticallyQueued` check (Search.tsx:561-563) accidentally matching across folders when keys are shared. The fix below addresses both mechanisms regardless of which is active.

### Three download flows with different key formats

| Flow | Key source | Key format |
|------|-----------|------------|
| **Tracks view** (Search.tsx:257) | Network search result `file.filename` | Full Soulseek path: `username:@@user\Music\Album\Track.mp3` |
| **Folders view** (Search.tsx:580) | Network search result `f.filename` per group | Full Soulseek path (same as tracks) |
| **FolderBrowser** (Search.tsx:614) | Browse API `f.filename` | May differ from network search format |

### Fix

**1. Normalize keys:** Ensure all three flows produce identical key format for the same file. Verify that browse API filenames match network search filenames after the `ba38073` fix. If not, normalize on the frontend before adding to the Set.

**2. Folder-level optimistic state:** Add `downloadedFolders: Set<string>` to `useSearchStore`, keyed as `"username:directoryPath"`.

- When downloading a folder (either from folder view or FolderBrowser), add `"username:directoryPath"` to `downloadedFolders`
- The `allOptimisticallyQueued` check in folders view changes from checking individual file keys to: `downloadedFolders.has(\`${group.username}:${group.directory}\`)`
- `getFolderDownloadLabel` receives `isFolderQueued: boolean` (from `downloadedFolders`) instead of deriving it from individual file keys

**3. FolderBrowser persistent state:** Remove `optimisticQueued` local state from FolderBrowser. Instead, accept a `isFolderQueued` prop derived from `downloadedFolders` in the parent. This survives open/close cycles.

**4. Keep file-level keys for tracks view:** Individual track downloads still use the file-level `downloading` Set — no change needed there. The two Sets serve different purposes:
- `downloading: Set<string>` — individual file optimistic state (tracks view)
- `downloadedFolders: Set<string>` — folder-level optimistic state (folders view + FolderBrowser)

**5. Reset on new search:** The existing `reset()` action in the search store must also clear `downloadedFolders` (and `downloading`), since a new search produces a new result set.

### Files touched

| File | Change |
|------|--------|
| `packages/web/src/stores/search.ts` | Add `downloadedFolders` Set + `addDownloadedFolder()` |
| `packages/web/src/pages/Search.tsx` | Use `downloadedFolders` for folder view button state; pass `isFolderQueued` to FolderBrowser |
| `packages/web/src/components/FolderBrowser.tsx` | Remove `optimisticQueued` local state, accept `isFolderQueued` prop |
| `packages/web/src/lib/downloadStatus.ts` | `getFolderDownloadLabel` signature: `isQueued` now sourced from `downloadedFolders` |

---

## 5. Reduce Mobile Padding (Enhancement)

### Current → Target

| Element | Current | Mobile target | Desktop (unchanged) |
|---------|---------|---------------|-------------------|
| Page containers | `px-4 py-8` | `px-3 py-4` | `md:px-6 md:py-8` |
| NowPlaying cover/info sections | `px-8` | `px-4` | `md:px-8` |
| Header | `px-4 py-3` | No change | No change |
| Player bar | `px-3` | No change | No change |
| Search input | `px-5 py-4` | No change (good touch target) | No change |

### Pages to update

All pages using the `max-w-4xl mx-auto px-4 md:px-6 py-8` pattern:
- Search.tsx
- Downloads.tsx
- Library.tsx
- Playlists.tsx
- Settings.tsx
- Admin.tsx

### Files touched

| File | Change |
|------|--------|
| `packages/web/src/pages/Search.tsx` | `px-3 py-4 md:px-6 md:py-8` |
| `packages/web/src/pages/Downloads.tsx` | Same |
| `packages/web/src/pages/Library.tsx` | Same |
| `packages/web/src/pages/Playlists.tsx` | Same |
| `packages/web/src/pages/Settings.tsx` | Same |
| `packages/web/src/pages/Admin.tsx` | Same |
| `packages/web/src/components/NowPlaying.tsx` | `px-4 md:px-8` on cover + info sections |

---

## 6. Media Session API Integration (Enhancement)

### Purpose

Full OS media control integration: lock screen, notification shade, headphone buttons, Control Center. Covers Android Chrome (full), iOS Safari (partial, see caveats).

### Implementation — all in Player.tsx

**Metadata (useEffect on `currentTrack`):**
```
navigator.mediaSession.metadata = new MediaMetadata({
  title, artist, album,
  artwork: [
    { src: `/api/cover/${coverArt}?size=96&token=...`, sizes: '96x96', type: 'image/jpeg' },
    { src: `/api/cover/${coverArt}?size=256&token=...`, sizes: '256x256', type: 'image/jpeg' },
    { src: `/api/cover/${coverArt}?size=512&token=...`, sizes: '512x512', type: 'image/jpeg' },
  ]
})
```
Clear metadata when `currentTrack` is null.

**Playback state (useEffect on `isPlaying`):**
```
navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
```

**Action handlers (registered on mount):**

| Action | Handler |
|--------|---------|
| `play` | `resume()` |
| `pause` | `pause()` |
| `previoustrack` | `handlePrev()` (reuses >3s restart logic) |
| `nexttrack` | `playNext()` |
| `seekto` | `if (details.seekTime != null) seek(details.seekTime)` |
| `seekforward` | `seek(usePlayerStore.getState().currentTime + 10)` |
| `seekbackward` | `seek(Math.max(0, usePlayerStore.getState().currentTime - 10))` |

**Stale closure note:** All handlers must read current state via `usePlayerStore.getState()` at call time, not from the React render closure. This applies to `seekforward`, `seekbackward`, and `handlePrev` (which reads `audioRef.current.currentTime` — already safe since it's a ref). The `playNext`, `playPrev`, `pause`, `resume` store actions are stable functions and don't have this issue.

**Conditional next/previous (useEffect on `queue.length`, `history.length`, `repeat`):**
- Queue empty + repeat `off` → `setActionHandler('nexttrack', null)`
- History empty → `setActionHandler('previoustrack', null)`
- Otherwise → re-register handlers
- When `repeat === 'all'` or `repeat === 'one'`, next is always available

**Position state (in existing timeupdate listener):**
```
try {
  navigator.mediaSession.setPositionState({ duration, playbackRate: 1, position: currentTime });
} catch {}
```
Try/catch guards against older WebKit throwing on unsupported calls.

### Platform notes

- **Android Chrome:** Full support, all features work
- **iOS Safari 16.4+:** Full support including seek
- **iOS Safari < 16.4:** play/pause/next/prev work; seek silently ignored
- **iOS caveat:** Setting handler to `null` doesn't reliably grey out buttons — they appear but do nothing. Cosmetic-only issue.
- **PWA:** Works identically in standalone mode on both platforms

### Files touched

| File | Change |
|------|--------|
| `packages/web/src/components/Player.tsx` | All Media Session logic (3 useEffects + position state in timeupdate) |

---

## Implementation Order

1. **Reduce mobile padding** — smallest change, immediate visual improvement
2. **Bug fix: folder download state** — unblocks normal usage
3. **Folder browser mobile** — standalone component change
4. **Media Session API** — standalone, Player.tsx only
5. **Artist "Search more" + quick wins** — touches many files but each change is small
6. **Search similar tracks** — largest scope (new API endpoint + navidrome-client method + frontend)

Items 1-4 are independent and can be parallelized. Items 5-6 both touch the search store and page, so they should be sequenced.

### Cross-section interactions

- **Sections 1 + 2 share `TrackContextMenu`:** Both "Find similar" and "Search more by artist" appear in the same context menu component. Implement the shared component in section 5 (artist search more), then add the "Find similar" item in section 6.
- **Similar results vs auto-search:** These are independent code paths. `autoSearch` triggers a normal search (local + network). `similarResults` displays pre-fetched local results. If a user triggers "Find similar" while `autoSearch` is pending, the similar results take precedence (clear `autoSearch`).
- **Similar results are not added to search history** — they are not user-typed queries.

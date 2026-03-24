# UX Enhancements Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement six UX improvements: mobile padding, folder download state bug fix, folder browser mobile drill-down, Media Session API, artist search shortcuts, and local similarity search.

**Architecture:** All changes are additive. Tasks 1–4 are independent and can run in parallel. Tasks 5–6 are sequenced (5 builds the context menu and navigation hook that 6 extends). Backend changes (Task 6) follow the existing Hono + `navidrome-client` pattern; all new state lives in Zustand stores using the same patterns as `useSearchStore` and `useTransferStore`.

**Tech Stack:** Bun, React 19, React Router 7 (`BrowserRouter`), Zustand 5, Tailwind 4, Hono, `bun:test`

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Modify | `packages/web/src/pages/Search.tsx` | Padding, executeSearch refactor, auto-search, history, similar results, clickable names |
| Modify | `packages/web/src/pages/Downloads.tsx` | Padding, clickable artist names in recent songs |
| Modify | `packages/web/src/pages/Library.tsx` | Padding |
| Modify | `packages/web/src/pages/Playlists.tsx` | Padding |
| Modify | `packages/web/src/pages/Settings.tsx` | Padding |
| Modify | `packages/web/src/pages/Admin.tsx` | Padding |
| Modify | `packages/web/src/components/NowPlaying.tsx` | Padding, clickable artist/album |
| Modify | `packages/web/src/components/Player.tsx` | Media Session API, clickable artist name |
| Modify | `packages/web/src/components/FolderBrowser.tsx` | Mobile drill-down, scroll-to-selected, isFolderQueued prop |
| Modify | `packages/web/src/stores/search.ts` | downloadedFolders, autoSearch, history, similarTo, similarResults |
| Create | `packages/web/src/hooks/useNavigateAndSearch.ts` | Hook wrapping useNavigate + store mutation |
| Create | `packages/web/src/components/TrackContextMenu.tsx` | "Search more by artist" + "Find similar" context menu |
| Modify | `packages/web/src/lib/api.ts` | getSimilarSongs() |
| Modify | `packages/navidrome-client/src/api/browsing.ts` | getSongsByGenre() |
| Modify | `packages/api/src/routes/library.ts` | GET /songs/:id/similar endpoint |
| Create | `packages/api/src/routes/library.similar.test.ts` | bun:test for similarity endpoint |

---

## Task 1: Reduce Mobile Padding

**Files:**
- Modify: `packages/web/src/pages/Search.tsx`
- Modify: `packages/web/src/pages/Downloads.tsx`
- Modify: `packages/web/src/pages/Library.tsx`
- Modify: `packages/web/src/pages/Playlists.tsx`
- Modify: `packages/web/src/pages/Settings.tsx`
- Modify: `packages/web/src/pages/Admin.tsx`
- Modify: `packages/web/src/components/NowPlaying.tsx`

- [ ] **Step 1: Update page container padding on all six pages**

In each of the six pages, find the outermost container div (the one with `max-w-4xl mx-auto`) and change:

```
px-4 md:px-6 py-8
→
px-3 py-4 md:px-6 md:py-8
```

Run `grep -n "px-4 md:px-6 py-8" packages/web/src/pages/*.tsx` to locate all occurrences, then apply the change to each.

- [ ] **Step 2: Update NowPlaying cover and info padding**

In `packages/web/src/components/NowPlaying.tsx`:

```tsx
// Cover art section (line ~84):
// Before:
className="flex-shrink-0 flex justify-center px-8 py-4"
// After:
className="flex-shrink-0 flex justify-center px-4 py-4 md:px-8"

// Track info section (line ~103):
// Before:
className="text-center px-8 mb-4"
// After:
className="text-center px-4 mb-4 md:px-8"

// Seek bar section (line ~112):
// Before:
className="px-8 mb-4"
// After:
className="px-4 mb-4 md:px-8"
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/pages/Search.tsx packages/web/src/pages/Downloads.tsx \
  packages/web/src/pages/Library.tsx packages/web/src/pages/Playlists.tsx \
  packages/web/src/pages/Settings.tsx packages/web/src/pages/Admin.tsx \
  packages/web/src/components/NowPlaying.tsx
git commit -m "enhance(web): tighten mobile padding on all pages and NowPlaying panel"
```

---

## Task 2: Bug Fix — Folder Download State Bleeding

**Files:**
- Modify: `packages/web/src/stores/search.ts`
- Modify: `packages/web/src/pages/Search.tsx`
- Modify: `packages/web/src/components/FolderBrowser.tsx`

### Step 1: Add `downloadedFolders` to the search store

- [ ] **Step 1: Extend the search store**

In `packages/web/src/stores/search.ts`, add `downloadedFolders` alongside `downloading`:

```ts
interface SearchState {
  query: string;
  local: LocalResults | null;
  network: NetworkResult[];
  networkState: 'idle' | 'searching' | 'complete';
  downloading: Set<string>;
  downloadedFolders: Set<string>;   // NEW: keyed as "username:directoryPath"
  canBrowse: boolean;

  setQuery: (query: string) => void;
  setLocal: (local: LocalResults | null) => void;
  setNetwork: (network: NetworkResult[]) => void;
  setNetworkState: (state: 'idle' | 'searching' | 'complete') => void;
  addDownloading: (key: string) => void;
  addDownloadedFolder: (key: string) => void;  // NEW
  setCanBrowse: (v: boolean) => void;
  reset: () => void;
}

export const useSearchStore = create<SearchState>((set) => ({
  query: '',
  local: null,
  network: [],
  networkState: 'idle',
  downloading: new Set(),
  downloadedFolders: new Set(),   // NEW
  canBrowse: false,

  setQuery: (query) => set({ query }),
  setLocal: (local) => set({ local }),
  setNetwork: (network) => set({ network }),
  setNetworkState: (networkState) => set({ networkState }),
  addDownloading: (key) => set((s) => ({ downloading: new Set(s.downloading).add(key) })),
  addDownloadedFolder: (key) => set((s) => ({ downloadedFolders: new Set(s.downloadedFolders).add(key) })),  // NEW
  setCanBrowse: (canBrowse) => set({ canBrowse }),
  reset: () => set({ local: null, network: [], networkState: 'idle', canBrowse: false, downloading: new Set(), downloadedFolders: new Set() }),  // clear both Sets on reset
}));
```

- [ ] **Step 2: Update folders view in Search.tsx to use `downloadedFolders`**

At the top of `SearchPage`, add these selectors (alongside existing ones):
```tsx
const downloadedFolders = useSearchStore((s) => s.downloadedFolders);
const addDownloadedFolder = useSearchStore((s) => s.addDownloadedFolder);
```

Locate the `allOptimisticallyQueued` computation (~line 561-563) in the folders view inside `viewMode === 'folders'`. Replace it:

```tsx
// BEFORE:
const allOptimisticallyQueued =
  folderFiles.length > 0 &&
  folderFiles.every((f) => downloading.has(`${f.username}:${f.filename}`));

// AFTER (per-group, inside the map callback — no hook call here, just a Set lookup):
const isFolderQueued = downloadedFolders.has(`${group.username}:${group.directory}`);
const folderBtn = getFolderDownloadLabel(folderFiles, isFolderQueued, getStatus);
```

Also add `addDownloadedFolder` usage (it was declared at the top above):
```tsx
const addDownloadedFolder = useSearchStore((s) => s.addDownloadedFolder);
```

Update the folder-view "Download folder" button click handler (~line 578-584):
```tsx
onClick={async () => {
  const validFiles = group.files.filter((f) => f.size > 0);
  addDownloadedFolder(`${group.username}:${group.directory}`);  // NEW: folder-level key
  for (const f of validFiles) addDownloading(`${group.username}:${f.filename}`);
  await api.enqueueDownload(
    group.username,
    validFiles.map((f) => ({ filename: f.filename, size: f.size })),
  );
}}
```

Pass `isFolderQueued` to FolderBrowser when rendered in the folders view (~line 601-619):
```tsx
<FolderBrowser
  username={group.username}
  matchedPath={group.directory}
  fallbackFiles={...}
  onDownload={async (files) => {
    const validFiles = files.filter((f) => f.size > 0);
    addDownloadedFolder(`${group.username}:${group.directory}`);  // NEW
    for (const f of validFiles) addDownloading(`${group.username}:${f.filename}`);
    await api.enqueueDownload(group.username, validFiles);
  }}
  getStatus={getStatus}
  isFolderQueued={downloadedFolders.has(`${group.username}:${group.directory}`)}  // NEW
/>
```

- [ ] **Step 3: Update FolderBrowser to accept `isFolderQueued` prop**

In `packages/web/src/components/FolderBrowser.tsx`:

```tsx
interface FolderBrowserProps {
  username: string;
  matchedPath: string;
  fallbackFiles: BrowseFile[];
  onDownload: (files: Array<{ filename: string; size: number }>) => void;
  getStatus?: (username: string, filename: string) => TransferEntry | undefined;
  isFolderQueued?: boolean;  // NEW: replaces local optimisticQueued state
}

export function FolderBrowser({
  username,
  matchedPath,
  fallbackFiles,
  onDownload,
  getStatus,
  isFolderQueued = false,  // NEW
}: FolderBrowserProps) {
  // REMOVE: const [optimisticQueued, setOptimisticQueued] = useState(false);
```

In the Download all button, replace `optimisticQueued` with `isFolderQueued`:
```tsx
const btn = getStatus
  ? getFolderDownloadLabel(folderFiles, isFolderQueued, getStatus)
  : isFolderQueued
    ? { label: 'Queued', variant: 'queued' as const, disabled: true }
    : { label: `Download all (${validFiles.length})`, variant: 'default' as const, disabled: false };

// In the button onClick, remove setOptimisticQueued(true) — parent now owns this state:
onClick={() => {
  onDownload(validFiles.map((f) => ({ filename: f.filename, size: f.size })));
}}
```

- [ ] **Step 4: Verify fix manually**

Start the dev server (`bun run dev` from root or run the web dev server), search for something with multiple folders from the same user, download one folder and confirm the others remain downloadable.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/stores/search.ts packages/web/src/pages/Search.tsx \
  packages/web/src/components/FolderBrowser.tsx
git commit -m "fix(web): use folder-level optimistic state to prevent cross-folder download bleeding"
```

---

## Task 3: Folder Browser Mobile Drill-Down

**Files:**
- Modify: `packages/web/src/components/FolderBrowser.tsx`

This task adds a mobile drill-down view alongside the existing desktop tree, using CSS visibility only (no JS media query).

- [ ] **Step 1: Add breadcrumb parsing helper and drill-down state**

At the top of `FolderBrowser.tsx`, add a helper to derive breadcrumb segments from a path:

```ts
function pathSegments(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean);
}

function buildBreadcrumb(path: string): Array<{ label: string; path: string }> {
  const segs = pathSegments(path);
  return segs.map((seg, i) => ({
    label: seg,
    path: segs.slice(0, i + 1).join('\\'),
  }));
}
```

The `selected` state already exists — mobile just needs to navigate it. No new state needed.

- [ ] **Step 2: Add scroll-to-selected fix in TreeNode**

Replace the existing `TreeNode` component with one that scrolls into view when selected:

```tsx
function TreeNode({
  node,
  selected,
  onSelect,
}: {
  node: FolderNode;
  selected: string;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(selected.startsWith(node.fullPath));
  const isSelected = selected === node.fullPath;

  return (
    <div>
      <button
        ref={(el) => {
          if (el && isSelected) {
            // Scroll selected node into view when it becomes selected
            el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
        }}
        onClick={() => {
          setExpanded((e) => !e);
          onSelect(node.fullPath);
        }}
        className={`w-full text-left flex items-center gap-1 px-2 py-1 rounded text-xs transition ${
          isSelected
            ? 'bg-zinc-700 text-zinc-100'
            : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
        }`}
      >
        <span>{expanded ? '▾' : '▸'}</span>
        <span className="truncate">{node.segment}</span>
      </button>
      {expanded && node.children.length > 0 && (
        <div className="pl-3">
          {node.children.map((child) => (
            <TreeNode key={child.fullPath} node={child} selected={selected} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add mobile breadcrumb + drill-down layout**

Inside the main `FolderBrowser` return, wrap the layout so desktop keeps the existing two-panel, and mobile gets breadcrumb + single list. The `dirs` tree data is shared:

```tsx
{/* Mobile layout (hidden on md+) */}
<div className="md:hidden">
  {/* Breadcrumb */}
  <div className="flex items-center gap-1 px-3 py-2 border-b border-zinc-800 overflow-x-auto">
    {buildBreadcrumb(selected).map((crumb, i, arr) => (
      <span key={crumb.path} className="flex items-center gap-1 shrink-0">
        {i > 0 && <span className="text-zinc-700">›</span>}
        <button
          onClick={() => setSelected(crumb.path)}
          className={`text-xs ${i === arr.length - 1 ? 'text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'}`}
        >
          {crumb.label}
        </button>
      </span>
    ))}
  </div>

  {/* Drill-down list */}
  <div className="overflow-y-auto max-h-64 p-1">
    {/* Subfolders for current selected path */}
    {!loading && !error && dirs && (() => {
      const currentNode = tree.find(n => n.fullPath === selected) ??
        findNode(tree, selected);  // helper needed — see below
      const children = currentNode?.children ?? [];
      return children.map(child => (
        <button
          key={child.fullPath}
          onClick={() => setSelected(child.fullPath)}
          className="w-full text-left flex items-center justify-between px-2 py-1.5 rounded text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          <span className="flex items-center gap-1.5 truncate">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="shrink-0 text-zinc-600">
              <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/>
            </svg>
            {child.segment}
          </span>
          <span className="text-zinc-700">›</span>
        </button>
      ));
    })()}
    {/* Files */}
    {directFiles.map((file) => (
      <div key={file.filename} className="flex items-center justify-between text-[11px] text-zinc-500 hover:text-zinc-300 px-2 py-1">
        <span className="truncate flex-1">{extractBasename(file.filename)}</span>
        <span className="shrink-0 ml-2 text-zinc-700">
          {file.bitRate ? `${file.bitRate} kbps · ` : ''}{formatSize(file.size)}
        </span>
      </div>
    ))}
  </div>
</div>

{/* Desktop layout (hidden below md) */}
<div className="hidden md:flex min-h-[120px] max-h-64">
  {/* Existing tree panel + file panel — unchanged */}
  ...
</div>
```

Add the `findNode` helper (recursive tree search):
```ts
function findNode(nodes: FolderNode[], path: string): FolderNode | null {
  for (const n of nodes) {
    if (n.fullPath === path) return n;
    const found = findNode(n.children, path);
    if (found) return found;
  }
  return null;
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/FolderBrowser.tsx
git commit -m "enhance(web/FolderBrowser): mobile drill-down navigation and desktop scroll-to-selected fix"
```

---

## Task 4: Media Session API Integration

**Files:**
- Modify: `packages/web/src/components/Player.tsx`

- [ ] **Step 1: Add metadata useEffect**

After the existing "Load track" `useEffect` (line ~30), add:

```tsx
// Media Session: update metadata when track changes
useEffect(() => {
  if (!('mediaSession' in navigator)) return;

  if (!currentTrack) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
    return;
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title: currentTrack.title,
    artist: currentTrack.artist,
    album: currentTrack.album ?? '',
    artwork: currentTrack.coverArt
      ? [
          { src: `/api/cover/${currentTrack.coverArt}?size=96&token=${token}`, sizes: '96x96', type: 'image/jpeg' },
          { src: `/api/cover/${currentTrack.coverArt}?size=256&token=${token}`, sizes: '256x256', type: 'image/jpeg' },
          { src: `/api/cover/${currentTrack.coverArt}?size=512&token=${token}`, sizes: '512x512', type: 'image/jpeg' },
        ]
      : [],
  });
}, [currentTrack, token]);
```

- [ ] **Step 2: Add playback state sync useEffect**

```tsx
// Media Session: sync playback state
useEffect(() => {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
}, [isPlaying]);
```

- [ ] **Step 3: Add action handlers useEffect**

```tsx
// Media Session: action handlers + conditional enable/disable of next/prev
useEffect(() => {
  if (!('mediaSession' in navigator)) return;

  const { queue, history, repeat } = usePlayerStore.getState();
  const canGoNext = queue.length > 0 || repeat === 'all' || repeat === 'one';
  const canGoPrev = history.length > 0;

  navigator.mediaSession.setActionHandler('play', () => usePlayerStore.getState().resume());
  navigator.mediaSession.setActionHandler('pause', () => usePlayerStore.getState().pause());
  navigator.mediaSession.setActionHandler('nexttrack', canGoNext
    ? () => usePlayerStore.getState().playNext()
    : null
  );
  navigator.mediaSession.setActionHandler('previoustrack', canGoPrev
    ? () => {
        const audio = audioRef.current;
        if (audio && audio.currentTime > 3) {
          audio.currentTime = 0;
        } else {
          usePlayerStore.getState().playPrev();
        }
      }
    : null
  );
  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime != null) usePlayerStore.getState().seek(details.seekTime);
  });
  navigator.mediaSession.setActionHandler('seekforward', () => {
    const current = usePlayerStore.getState().currentTime;
    usePlayerStore.getState().seek(current + 10);
  });
  navigator.mediaSession.setActionHandler('seekbackward', () => {
    const current = usePlayerStore.getState().currentTime;
    usePlayerStore.getState().seek(Math.max(0, current - 10));
  });
}, [queue, history, repeat]);  // re-register when queue/history/repeat change
```

Add `queue` and `history` to the destructured store values at the top of `Player` (`repeat` is already present):
```tsx
// Current destructuring already has: currentTrack, isPlaying, pause, resume, playNext, playPrev,
// shuffle, toggleShuffle, repeat, cycleRepeat, setCurrentTime, setDuration, currentTime, duration,
// seekTo, clearSeek, setNowPlayingOpen
// Add only: queue, history
const { queue, history, /* all existing fields unchanged */ } = usePlayerStore();
```

- [ ] **Step 4: Add position state to the timeupdate listener**

In the existing audio events `useEffect`, update the `onTime` handler:

```tsx
const onTime = () => {
  const value = audio.currentTime;
  if (Number.isFinite(value) && value >= 0) {
    setCurrentTime(value);
    // Media Session position state
    if ('mediaSession' in navigator && safeDuration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: safeDuration,
          playbackRate: 1,
          position: value,
        });
      } catch {
        // Older WebKit may throw — silently ignore
      }
    }
  }
};
```

Note: `safeDuration` is computed earlier in the component — ensure it's in scope or re-derive from `audio.duration` inside the handler.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/Player.tsx
git commit -m "feat(web/Player): full Media Session API integration with conditional next/prev"
```

---

## Task 5: Artist "Search More" + Quick Wins

**Files:**
- Create: `packages/web/src/hooks/useNavigateAndSearch.ts`
- Modify: `packages/web/src/stores/search.ts`
- Modify: `packages/web/src/pages/Search.tsx`
- Create: `packages/web/src/components/TrackContextMenu.tsx`
- Modify: `packages/web/src/components/NowPlaying.tsx`
- Modify: `packages/web/src/components/Player.tsx`
- Modify: `packages/web/src/pages/Downloads.tsx`
- Modify: `packages/web/src/components/FolderBrowser.tsx`

### Step A: Navigation hook and store extensions

- [ ] **Step 1: Create `useNavigateAndSearch` hook**

```ts
// packages/web/src/hooks/useNavigateAndSearch.ts
import { useNavigate } from 'react-router-dom';
import { useSearchStore } from '@/stores/search';

export function useNavigateAndSearch() {
  const navigate = useNavigate();
  const setQuery = useSearchStore((s) => s.setQuery);
  const setAutoSearch = useSearchStore((s) => s.setAutoSearch);

  return (query: string) => {
    setQuery(query);
    setAutoSearch(true);
    navigate('/');
  };
}
```

- [ ] **Step 2: Extend search store with `autoSearch` and `history`**

In `packages/web/src/stores/search.ts`, add to the interface and implementation:

```ts
interface SearchState {
  // ... existing fields ...
  autoSearch: boolean;
  history: string[];

  setAutoSearch: (v: boolean) => void;
  addToHistory: (query: string) => void;
  clearHistory: () => void;
}

// In create():
autoSearch: false,
history: JSON.parse(localStorage.getItem('nicotind:search-history') ?? '[]') as string[],

setAutoSearch: (autoSearch) => set({ autoSearch }),

addToHistory: (query) => set((s) => {
  const trimmed = query.trim();
  if (!trimmed) return s;
  const updated = [trimmed, ...s.history.filter((h) => h !== trimmed)].slice(0, 10);
  localStorage.setItem('nicotind:search-history', JSON.stringify(updated));
  return { history: updated };
}),

clearHistory: () => {
  localStorage.removeItem('nicotind:search-history');
  set({ history: [] });
},
```

- [ ] **Step 3: Commit store + hook**

```bash
git add packages/web/src/stores/search.ts packages/web/src/hooks/useNavigateAndSearch.ts
git commit -m "feat(web): add autoSearch + search history to store, useNavigateAndSearch hook"
```

### Step B: Refactor Search.tsx and add auto-search

- [ ] **Step 4: Extract `executeSearch` from `handleSearch` in Search.tsx**

The current `handleSearch` takes `(e: React.FormEvent)`. Extract the core logic:

```tsx
// New standalone function (inside SearchPage, as a useCallback):
const executeSearch = useCallback(async () => {
  if (!query.trim()) return;

  const prevId = searchId;
  if (prevId) cleanupSearch(prevId);

  setLoading(true);
  useSearchStore.getState().reset();
  setErrors([]);
  setSearchError(null);
  setNetworkAvailable(true);

  // Add to history on explicit search
  useSearchStore.getState().addToHistory(query.trim());

  try {
    const res = await api.search(query.trim());
    setLocal(res.local);
    setSearchId(res.searchId);
    setErrors(res.errors ?? []);
    setNetworkAvailable(res.networkAvailable ?? false);
    setNetworkState(res.networkAvailable ? 'searching' : 'complete');
  } catch (err) {
    setSearchError(err instanceof Error ? err.message : 'Search failed');
  } finally {
    setLoading(false);
  }
}, [query, searchId, cleanupSearch, setLocal, setNetworkState]);

// handleSearch becomes a thin wrapper:
const handleSearch = useCallback((e: React.FormEvent) => {
  e.preventDefault();
  void executeSearch();
}, [executeSearch]);
```

- [ ] **Step 5: Add auto-search effect**

Add after the `useEffect` that checks Soulseek network status:

```tsx
const autoSearch = useSearchStore((s) => s.autoSearch);
const setAutoSearch = useSearchStore((s) => s.setAutoSearch);

useEffect(() => {
  if (autoSearch && query.trim()) {
    setAutoSearch(false);
    void executeSearch();
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // Intentionally omitting executeSearch from deps: it is a useCallback that changes whenever
  // `query` changes, which would cause this effect to re-fire mid-search. We only want to
  // trigger on autoSearch flag transitions. executeSearch reads query from the store at call time.
}, [autoSearch]);
```

- [ ] **Step 6: Add search history dropdown**

Add local state for focus:
```tsx
const [searchFocused, setSearchFocused] = useState(false);
const history = useSearchStore((s) => s.history);
const clearHistory = useSearchStore((s) => s.clearHistory);
const navigateAndSearch = useNavigateAndSearch();
```

Wrap the search input in a `relative` container and add the dropdown:
```tsx
<form onSubmit={handleSearch} className="mb-4">
  <div className="relative">
    <input
      type="text"
      value={query}
      onChange={(e) => setQuery(e.target.value)}
      onFocus={() => setSearchFocused(true)}
      onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
      placeholder="Search for music..."
      className="w-full px-5 py-4 text-lg rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 transition"
    />
    <button type="submit" disabled={loading} className="absolute right-3 top-1/2 -translate-y-1/2 px-4 py-2 rounded-lg bg-zinc-700 text-zinc-200 text-sm font-medium hover:bg-zinc-600 transition disabled:opacity-50">
      {loading ? 'Searching...' : 'Search'}
    </button>

    {/* Search history dropdown */}
    {searchFocused && history.length > 0 && !query && (
      <div className="absolute top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden z-10">
        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
          <span className="text-xs text-zinc-500 font-medium">Recent searches</span>
          <button onClick={clearHistory} className="text-xs text-zinc-600 hover:text-zinc-400 transition">Clear all</button>
        </div>
        {history.map((h) => (
          <button
            key={h}
            onClick={() => navigateAndSearch(h)}
            className="w-full text-left px-4 py-2.5 text-sm text-zinc-300 hover:bg-zinc-800 transition"
          >
            {h}
          </button>
        ))}
      </div>
    )}
  </div>
</form>
```

- [ ] **Step 7: Add clickable artist/album names to local results in Search.tsx**

In the songs section, wrap artist/album text:
```tsx
<p className="text-xs text-zinc-500 truncate">
  <button
    onClick={(e) => { e.stopPropagation(); navigateAndSearch(song.artist); }}
    className="hover:underline hover:text-zinc-300 transition"
  >
    {highlightText(song.artist, highlightTerms)}
  </button>
  &middot;
  <button
    onClick={(e) => { e.stopPropagation(); navigateAndSearch(song.album); }}
    className="hover:underline hover:text-zinc-300 transition"
  >
    {highlightText(song.album, highlightTerms)}
  </button>
</p>
```

In the albums section, wrap artist text similarly.

- [ ] **Step 8: Commit Search.tsx changes**

```bash
git add packages/web/src/pages/Search.tsx
git commit -m "feat(web/Search): extract executeSearch, auto-search on mount, history dropdown, clickable artist/album"
```

### Step C: TrackContextMenu component

- [ ] **Step 9: Create `TrackContextMenu` component**

```tsx
// packages/web/src/components/TrackContextMenu.tsx
import { useNavigateAndSearch } from '@/hooks/useNavigateAndSearch';

interface TrackContextMenuProps {
  artist: string;
  trackId?: string;          // required for "Find similar"
  trackTitle?: string;       // for display in "Find similar"
  onFindSimilar?: (id: string) => void;  // provided by parent; undefined = hide item
  onClose: () => void;
  position: { x: number; y: number };
}

export function TrackContextMenu({
  artist,
  trackId,
  trackTitle,
  onFindSimilar,
  onClose,
  position,
}: TrackContextMenuProps) {
  const navigateAndSearch = useNavigateAndSearch();

  return (
    <>
      {/* Backdrop — click to close */}
      <div className="fixed inset-0 z-[70]" onClick={onClose} />
      <div
        className="fixed z-[80] bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl py-1 min-w-[180px]"
        style={{ top: position.y, left: position.x }}
      >
        <button
          onClick={() => { navigateAndSearch(artist); onClose(); }}
          className="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition"
        >
          Search more by artist
        </button>
        {onFindSimilar && trackId && (
          <button
            onClick={() => { onFindSimilar(trackId); onClose(); }}
            className="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition"
          >
            Find similar to "{trackTitle ?? 'this track'}"
          </button>
        )}
      </div>
    </>
  );
}
```

Usage pattern (to be applied in Search.tsx local songs section, NowPlaying, Downloads):
```tsx
const [contextMenu, setContextMenu] = useState<{ x: number; y: number; artist: string; trackId?: string; trackTitle?: string } | null>(null);

// On long press or right-click on a track row:
onContextMenu={(e) => {
  e.preventDefault();
  setContextMenu({ x: e.clientX, y: e.clientY, artist: song.artist, trackId: song.id, trackTitle: song.title });
}}

// Render:
{contextMenu && (
  <TrackContextMenu
    artist={contextMenu.artist}
    trackId={contextMenu.trackId}
    trackTitle={contextMenu.trackTitle}
    onClose={() => setContextMenu(null)}
    position={contextMenu}
    onFindSimilar={/* Task 6 wires this up */}
  />
)}
```

- [ ] **Step 10: Add context menu + clickable artist to NowPlaying.tsx**

```tsx
// Add to NowPlaying.tsx imports:
import { TrackContextMenu } from '@/components/TrackContextMenu';
import { useNavigateAndSearch } from '@/hooks/useNavigateAndSearch';

// Inside NowPlaying():
const navigateAndSearch = useNavigateAndSearch();
const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

// Make artist name clickable:
<p
  className="text-sm text-zinc-400 truncate mt-1 cursor-pointer hover:underline hover:text-zinc-200 transition"
  onClick={() => { setNowPlayingOpen(false); navigateAndSearch(currentTrack.artist); }}
>
  {currentTrack.artist}
</p>

// Make album name (if shown) clickable similarly for album.

// Context menu on long-press (use onContextMenu for desktop):
<h2
  className="text-xl font-semibold text-zinc-100 truncate"
  onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY }); }}
>
  {currentTrack.title}
</h2>

{contextMenu && currentTrack && (
  <TrackContextMenu
    artist={currentTrack.artist}
    onClose={() => setContextMenu(null)}
    position={contextMenu}
  />
)}
```

- [ ] **Step 11: Add clickable artist to Player.tsx mini bar**

```tsx
// In Player.tsx, import:
import { useNavigateAndSearch } from '@/hooks/useNavigateAndSearch';

// Inside Player():
const navigateAndSearch = useNavigateAndSearch();

// Wrap artist text in mini bar:
<p
  className="text-xs text-zinc-400 truncate cursor-pointer hover:underline hover:text-zinc-200 transition"
  onClick={(e) => { e.stopPropagation(); navigateAndSearch(currentTrack.artist); }}
>
  {currentTrack.artist}
</p>
```

- [ ] **Step 12: Add clickable artist to Downloads.tsx recent songs**

In the recent songs list, find the artist text render and wrap it:
```tsx
<span
  className="text-xs text-zinc-500 truncate cursor-pointer hover:underline hover:text-zinc-300 transition"
  onClick={() => navigateAndSearch(song.artist)}
>
  {song.artist}
</span>
```

Add `useNavigateAndSearch` hook import and usage at the top of the component.

- [ ] **Step 13: Add clickable directory basename in FolderBrowser**

In the folder list panel header in `FolderBrowser.tsx`, the directory basename is shown in the parent (Search.tsx). In `Search.tsx`, make the `dirBasename` text clickable:

```tsx
// In Search.tsx folders view, ~line 553:
<p
  className="text-sm text-zinc-300 truncate cursor-pointer hover:underline hover:text-zinc-100 transition"
  onClick={() => navigateAndSearch(dirBasename)}
>
  {dirBasename}
</p>
```

- [ ] **Step 14: Commit context menu and all clickable names**

```bash
git add packages/web/src/components/TrackContextMenu.tsx \
  packages/web/src/components/NowPlaying.tsx \
  packages/web/src/components/Player.tsx \
  packages/web/src/pages/Downloads.tsx \
  packages/web/src/components/FolderBrowser.tsx \
  packages/web/src/pages/Search.tsx
git commit -m "feat(web): TrackContextMenu with artist search, clickable artist/album names across surfaces"
```

---

## Task 6: Search Similar Tracks

**Files:**
- Modify: `packages/navidrome-client/src/api/browsing.ts`
- Modify: `packages/api/src/routes/library.ts`
- Create: `packages/api/src/routes/library.similar.test.ts`
- Modify: `packages/web/src/lib/api.ts`
- Modify: `packages/web/src/stores/search.ts`
- Modify: `packages/web/src/pages/Search.tsx`
- Modify: `packages/web/src/components/TrackContextMenu.tsx`

### Step A: Backend

- [ ] **Step 1: Add `getSongsByGenre` to navidrome-client**

In `packages/navidrome-client/src/api/browsing.ts`, add after `getRandomSongs`:

```ts
async getSongsByGenre(
  genre: string,
  count = 50,
  offset = 0,
): Promise<Song[]> {
  const res = await this.client.request<{ songsByGenre: { song?: Song[] } }>(
    'getSongsByGenre.view',
    { genre, count: String(count), offset: String(offset) },
  );
  return res.songsByGenre.song ?? [];
}
```

- [ ] **Step 2: Write the failing test for the similar endpoint**

Create `packages/api/src/routes/library.similar.test.ts`:

```ts
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { libraryRoutes } from './library.js';

describe('GET /songs/:id/similar', () => {
  let navidromeMock: any;
  let app: Hono<any>;

  const sourceSong = {
    id: 'song-src',
    title: 'Source',
    artist: 'Artist A',
    artistId: 'artist-1',
    album: 'Album X',
    albumId: 'album-1',
    genre: 'Jazz',
    year: 2010,
    path: '/music/Jazz/Artist A/Album X/song.flac',
    duration: 180,
    coverArt: 'cover-1',
    size: 1000,
    contentType: 'audio/flac',
    suffix: 'flac',
    bitRate: 320,
    created: '2024-01-01',
  };

  const artistAlbums = [
    { id: 'album-1', name: 'Album X', artist: 'Artist A', artistId: 'artist-1', songCount: 2, duration: 400, created: '2024-01-01' },
    { id: 'album-2', name: 'Album Y', artist: 'Artist A', artistId: 'artist-1', songCount: 2, duration: 350, created: '2023-01-01' },
  ];

  const album1Songs = [
    { ...sourceSong, id: 'song-src' },  // source itself
    { ...sourceSong, id: 'song-a2', title: 'Track 2', albumId: 'album-1' },
  ];
  const album2Songs = [
    { ...sourceSong, id: 'song-b1', title: 'B Track 1', albumId: 'album-2' },
  ];
  const genreSongs = [
    { ...sourceSong, id: 'song-g1', title: 'Genre Track', artist: 'Artist B', artistId: 'artist-2', year: 2012 },
  ];

  beforeEach(() => {
    navidromeMock = {
      browsing: {
        getSong: mock(() => Promise.resolve(sourceSong)),
        getArtist: mock(() => Promise.resolve({ artist: { id: 'artist-1', name: 'Artist A', albumCount: 2 }, albums: artistAlbums })),
        getAlbum: mock((id: string) => {
          if (id === 'album-1') return Promise.resolve({ album: artistAlbums[0], songs: album1Songs });
          if (id === 'album-2') return Promise.resolve({ album: artistAlbums[1], songs: album2Songs });
          return Promise.resolve({ album: {}, songs: [] });
        }),
        getSongsByGenre: mock(() => Promise.resolve(genreSongs)),
      },
    };

    app = new Hono();
    app.route('/', libraryRoutes(navidromeMock, '/music'));
  });

  it('returns similar songs excluding the source song', async () => {
    const res = await app.request('/songs/song-src/similar?size=20');
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body.find((s: any) => s.id === 'song-src')).toBeUndefined();
  });

  it('includes same-artist songs', async () => {
    const res = await app.request('/songs/song-src/similar?size=20');
    const body = await res.json() as any[];
    expect(body.find((s: any) => s.id === 'song-b1')).toBeDefined();
  });

  it('includes same-album songs', async () => {
    const res = await app.request('/songs/song-src/similar?size=20');
    const body = await res.json() as any[];
    expect(body.find((s: any) => s.id === 'song-a2')).toBeDefined();
  });

  it('includes genre songs', async () => {
    const res = await app.request('/songs/song-src/similar?size=20');
    const body = await res.json() as any[];
    expect(body.find((s: any) => s.id === 'song-g1')).toBeDefined();
  });

  it('ranks same-artist songs above genre-only songs', async () => {
    const res = await app.request('/songs/song-src/similar?size=20');
    const body = await res.json() as any[];
    const artistIdx = body.findIndex((s: any) => s.artist === 'Artist A');
    const genreIdx = body.findIndex((s: any) => s.id === 'song-g1');
    expect(artistIdx).toBeLessThan(genreIdx);
  });

  it('returns 404 for unknown song id', async () => {
    navidromeMock.browsing.getSong = mock(() => Promise.reject(new Error('Not Found')));
    const res = await app.request('/songs/nonexistent/similar');
    expect(res.status).toBe(404);
  });

  it('caps results at the requested size', async () => {
    const res = await app.request('/songs/song-src/similar?size=2');
    const body = await res.json() as any[];
    expect(body.length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

```bash
cd /path/to/NicotinD && bun test packages/api/src/routes/library.similar.test.ts
```

Expected: fails with `Cannot find route` or similar — endpoint not yet implemented.

- [ ] **Step 4: Implement the `/songs/:id/similar` endpoint**

In `packages/api/src/routes/library.ts`, add after the existing `GET /songs/:id` route:

```ts
app.get('/songs/:id/similar', async (c) => {
  const id = c.req.param('id');
  const size = Math.min(Number(c.req.query('size') ?? 20), 50);

  let source: Song;
  try {
    source = await navidrome.browsing.getSong(id);
  } catch {
    return c.json({ error: 'Song not found' }, 404);
  }

  type SimilarSong = {
    id: string; title: string; artist: string; album: string;
    duration?: number; coverArt?: string; genre?: string; year?: number;
  };
  const scored = new Map<string, { song: SimilarSong; score: number }>();

  function add(song: Song, delta: number) {
    if (song.id === source.id) return;
    const entry = scored.get(song.id);
    const slim: SimilarSong = {
      id: song.id, title: song.title, artist: song.artist,
      album: song.album, duration: song.duration,
      coverArt: song.coverArt, genre: song.genre, year: song.year,
    };
    if (entry) {
      entry.score += delta;
    } else {
      scored.set(song.id, { song: slim, score: delta });
    }
  }

  // Source path prefix for heuristic (first 2 directory components)
  const sourceDirParts = source.path.split('/').filter(Boolean).slice(0, -1);
  const pathPrefix = sourceDirParts.slice(0, 2).join('/');

  // Parallel: artist albums + genre songs
  const [artistData, genreSongs] = await Promise.all([
    navidrome.browsing.getArtist(source.artistId).catch(() => null),
    source.genre
      ? navidrome.browsing.getSongsByGenre(source.genre, 200).catch(() => [] as Song[])
      : Promise.resolve([] as Song[]),
  ]);

  // Process artist albums (cap at 10)
  if (artistData) {
    const albums = artistData.albums.slice(0, 10);
    for (const album of albums) {
      try {
        const { songs } = await navidrome.browsing.getAlbum(album.id);
        for (const song of songs) {
          const score = song.albumId === source.albumId ? 5 : 10;
          add(song, score);
          // Path heuristic boost
          if (pathPrefix && song.path.includes(pathPrefix)) {
            add(song, 4);
          }
        }
      } catch {
        // Skip unreachable album
      }
    }
  }

  // Process genre songs
  const yearMin = source.year ? source.year - 5 : null;
  const yearMax = source.year ? source.year + 5 : null;
  const filteredGenre = genreSongs.filter((s) => {
    if (s.artistId === source.artistId) return false; // already covered by artist tier
    if (yearMin && yearMax && s.year && (s.year < yearMin || s.year > yearMax)) return false;
    return true;
  });
  // Random sample up to 30 to avoid ordering bias
  const genreSample = filteredGenre
    .sort(() => Math.random() - 0.5)
    .slice(0, 30);
  for (const song of genreSample) {
    add(song, 3);
    if (pathPrefix && song.path.includes(pathPrefix)) {
      add(song, 4);
    }
  }

  const results = [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, size)
    .map((e) => e.song);

  return c.json(results);
});
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
bun test packages/api/src/routes/library.similar.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit backend**

```bash
git add packages/navidrome-client/src/api/browsing.ts \
  packages/api/src/routes/library.ts \
  packages/api/src/routes/library.similar.test.ts
git commit -m "feat(api): GET /songs/:id/similar endpoint with multi-signal scoring"
```

### Step B: Frontend

- [ ] **Step 7: Add `getSimilarSongs` to the API client**

In `packages/web/src/lib/api.ts`, add to the `api` object:

```ts
getSimilarSongs: (id: string, size = 20) =>
  request<Array<{
    id: string;
    title: string;
    artist: string;
    album: string;
    duration?: number;
    coverArt?: string;
    genre?: string;
    year?: number;
  }>>(`/api/library/songs/${id}/similar?size=${size}`),
```

- [ ] **Step 8: Add `similarTo` and `similarResults` to search store**

In `packages/web/src/stores/search.ts`:

```ts
interface SearchState {
  // ... existing fields ...
  similarTo: { title: string; artist: string } | null;
  similarResults: Array<{ id: string; title: string; artist: string; album: string; duration?: number; coverArt?: string }>;

  setSimilar: (
    meta: { title: string; artist: string },
    results: Array<{ id: string; title: string; artist: string; album: string; duration?: number; coverArt?: string }>,
  ) => void;
  clearSimilar: () => void;
}

// In create():
similarTo: null,
similarResults: [],

setSimilar: (similarTo, similarResults) => set({ similarTo, similarResults }),
clearSimilar: () => set({ similarTo: null, similarResults: [] }),
```

Also update `reset()` to clear: `similarTo: null, similarResults: []`. Note: Task 2 already expanded `reset()` to include `downloading: new Set(), downloadedFolders: new Set()`. This step adds `similarTo: null, similarResults: []` on top of those — do not remove the Task 2 additions.

- [ ] **Step 9: Add similar results section to Search.tsx**

Add selectors and navigation at the top of `SearchPage` (alongside existing hooks):
```tsx
import { useNavigate } from 'react-router-dom';

// Inside SearchPage():
const navigate = useNavigate();
const similarTo = useSearchStore((s) => s.similarTo);
const similarResults = useSearchStore((s) => s.similarResults);
const clearSimilar = useSearchStore((s) => s.clearSimilar);
const setSimilar = useSearchStore((s) => s.setSimilar);
const downloadedFolders = useSearchStore((s) => s.downloadedFolders);  // if not added yet in Task 2
const [loadingSimilar, setLoadingSimilar] = useState(false);
```

Add handler for "Find similar" (called from TrackContextMenu):
```tsx
const handleFindSimilar = useCallback(async (id: string, title: string, artist: string) => {
  setLoadingSimilar(true);
  try {
    const results = await api.getSimilarSongs(id, 20);
    setSimilar({ title, artist }, results);
    // Navigate to / in case called from NowPlaying or Downloads (different routes)
    navigate('/');
  } catch {
    // Silently fail
  } finally {
    setLoadingSimilar(false);
  }
}, [setSimilar, navigate]);
```

Render similar results section (add before or instead of normal local results when `similarTo` is set):
```tsx
{similarTo && (
  <section className="mb-6">
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
        Similar to <span className="text-zinc-300">{similarTo.title}</span> · <span>{similarTo.artist}</span>
      </h2>
      <button
        onClick={clearSimilar}
        className="text-xs text-zinc-600 hover:text-zinc-400 transition"
      >
        Clear
      </button>
    </div>
    {loadingSimilar && (
      <div className="flex items-center gap-2 py-4 text-sm text-zinc-500">
        <span className="inline-block w-4 h-4 border-2 border-zinc-600 border-t-zinc-300 rounded-full animate-spin" />
        Finding similar tracks…
      </div>
    )}
    {similarResults.map((song) => (
      <button
        key={song.id}
        onClick={() => playSong(song)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-zinc-800/50 transition text-left group"
      >
        {song.coverArt ? (
          <img src={`/api/cover/${song.coverArt}?size=80&token=${token}`} alt="" className="w-10 h-10 rounded object-cover flex-shrink-0" />
        ) : (
          <div className="w-10 h-10 rounded bg-zinc-800 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-zinc-100 truncate">{song.title}</p>
          <p className="text-xs text-zinc-500 truncate">{song.artist} · {song.album}</p>
        </div>
        <span className="text-xs text-zinc-600">{formatDuration(song.duration)}</span>
      </button>
    ))}
  </section>
)}
```

- [ ] **Step 10: Wire "Find similar" into TrackContextMenu and Search.tsx local results**

In `TrackContextMenu.tsx`, the `onFindSimilar` prop was already defined as `(id: string) => void`. Update the call to also pass title/artist. Update the interface:
```tsx
onFindSimilar?: (id: string, title: string, artist: string) => void;

// Button handler:
onClick={() => { onFindSimilar(trackId, trackTitle ?? '', artist); onClose(); }}
```

In Search.tsx local songs section, wire the context menu:
```tsx
<TrackContextMenu
  artist={contextMenu.artist}
  trackId={contextMenu.trackId}
  trackTitle={contextMenu.trackTitle}
  onFindSimilar={(id, title, artist) => handleFindSimilar(id, title, artist)}
  onClose={() => setContextMenu(null)}
  position={contextMenu}
/>
```

Pass the same `onFindSimilar` in NowPlaying and Downloads context menus.

- [ ] **Step 11: Run all backend tests**

```bash
bun test packages/api/src/routes/
```

Expected: all tests pass.

- [ ] **Step 12: Commit frontend similar tracks**

```bash
git add packages/web/src/lib/api.ts \
  packages/web/src/stores/search.ts \
  packages/web/src/pages/Search.tsx \
  packages/web/src/components/TrackContextMenu.tsx \
  packages/web/src/components/NowPlaying.tsx \
  packages/web/src/pages/Downloads.tsx
git commit -m "feat(web): Search similar tracks — context menu, similar results section, API integration"
```

---

## Final verification

- [ ] **Run full test suite**

```bash
bun test
```

Expected: all tests pass, including the new `library.similar.test.ts`.

- [ ] **Typecheck**

```bash
bun run typecheck
```

Expected: no TypeScript errors.

- [ ] **Lint**

```bash
bun run lint
```

Expected: no lint errors.

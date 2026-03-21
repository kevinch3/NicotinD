# Download Feedback & Folder Bug Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the folder download ghost-entry bug (size=0 stubs), and wire all download buttons in Search to show live status (Queued → ↓ 42% → ✓ Done / ✗ Error) from a shared global transfer store.

**Architecture:** Create a Zustand `useTransferStore` that polls `GET /api/downloads` once for the entire app. Migrate Downloads.tsx to consume from it, eliminating duplicate polling. A pure `downloadStatus.ts` helper (with shared `TransferEntry` type in `transferTypes.ts`, no Zustand deps) derives button labels/styles per file or folder. Search.tsx and FolderBrowser.tsx read transfer state via this helper.

**Tech Stack:** Bun, React, Zustand, TypeScript, bun:test

---

## File Map

| Action | File | Change |
|---|---|---|
| Create | `packages/web/src/lib/transferTypes.ts` | Shared `TransferEntry` type — no Zustand/API deps (required for bun:test resolution) |
| Modify | `packages/web/src/lib/api.ts` | Type `getDownloads()` return as `SlskdUserTransferGroup[]` |
| Create | `packages/web/src/stores/transfers.ts` | Global polling store; holds flat `Map` + raw `downloads[]`; imports `TransferEntry` from `transferTypes.ts` |
| Modify | `packages/web/src/App.tsx` | Start/stop polling on auth state change |
| Modify | `packages/web/src/pages/Downloads.tsx` | Remove local polling, read from store; replace `fetchDownloads()` refresh calls with `poll()` |
| Create | `packages/web/src/lib/downloadStatus.ts` | Pure helpers: `getSingleDownloadLabel`, `getFolderDownloadLabel`; imports `TransferEntry` from `./transferTypes` |
| Create | `packages/web/src/lib/downloadStatus.test.ts` | bun:test unit tests; imports via relative paths only |
| Modify | `packages/web/src/pages/Search.tsx` | Size filter + button feedback for track and folder views |
| Modify | `packages/web/src/components/FolderBrowser.tsx` | Size filter + optional `getStatus` prop for Download all button |

---

## Task 1: Create shared `TransferEntry` type

**Why a separate file:** `downloadStatus.ts` and its tests must import `TransferEntry`. The tests run under `bun:test` which does not resolve `@/` path aliases from tsconfig/vite. Extracting the type into a plain file with no Zustand or API dependencies lets both the implementation and the tests use relative imports that bun:test can resolve.

**Files:**
- Create: `packages/web/src/lib/transferTypes.ts`

- [ ] **Step 1: Create the types file**

```ts
import type { SlskdTransferState } from '@nicotind/core';

export interface TransferEntry {
  state: SlskdTransferState;
  percent: number;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/transferTypes.ts
git commit -m "feat(web): extract TransferEntry type to lib/transferTypes.ts for bun:test compat"
```

---

## Task 2: Type `getDownloads()` correctly in api.ts

**Files:**
- Modify: `packages/web/src/lib/api.ts`

- [ ] **Step 1: Update the return type**

In `packages/web/src/lib/api.ts`, add the import at the top (after existing imports):
```ts
import type { SlskdUserTransferGroup } from '@nicotind/core';
```

Change the `getDownloads` line from:
```ts
getDownloads: () => request<unknown[]>('/api/downloads'),
```
to:
```ts
getDownloads: () => request<SlskdUserTransferGroup[]>('/api/downloads'),
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run typecheck`
Expected: No errors — `SlskdUserTransferGroup` is structurally compatible with the local `Transfer` type in Downloads.tsx

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/api.ts
git commit -m "fix(web/api): type getDownloads() return as SlskdUserTransferGroup[]"
```

---

## Task 3: Create `useTransferStore`

**Files:**
- Create: `packages/web/src/stores/transfers.ts`
- Modify: `packages/web/src/App.tsx`

- [ ] **Step 1: Create the store**

Create `packages/web/src/stores/transfers.ts`:

```ts
import { create } from 'zustand';
import { api } from '@/lib/api';
import type { SlskdUserTransferGroup } from '@nicotind/core';
import type { TransferEntry } from '@/lib/transferTypes';

// Re-export so consumers can import from one place
export type { TransferEntry } from '@/lib/transferTypes';

interface TransferStore {
  /** Flat lookup map: "username:filename" → TransferEntry */
  transfers: Map<string, TransferEntry>;
  /** Raw grouped data for Downloads.tsx (same shape as SlskdUserTransferGroup[]) */
  downloads: SlskdUserTransferGroup[];
  _intervalId: ReturnType<typeof setInterval> | null;
  poll: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
  getStatus: (username: string, filename: string) => TransferEntry | undefined;
}

export const useTransferStore = create<TransferStore>((set, get) => ({
  transfers: new Map(),
  downloads: [],
  _intervalId: null,

  poll: async () => {
    try {
      const data = await api.getDownloads();
      const map = new Map<string, TransferEntry>();
      for (const group of data) {
        for (const dir of group.directories) {
          for (const file of dir.files) {
            map.set(`${group.username}:${file.filename}`, {
              state: file.state,
              percent: file.percentComplete,
            });
          }
        }
      }
      set({ transfers: map, downloads: data });
    } catch {
      // non-fatal: keep stale data on network error
    }
  },

  startPolling: () => {
    const { _intervalId, poll } = get();
    if (_intervalId) return; // guard: don't start twice
    poll();
    const id = setInterval(poll, 3000);
    set({ _intervalId: id });
  },

  stopPolling: () => {
    const { _intervalId } = get();
    if (_intervalId) clearInterval(_intervalId);
    set({ _intervalId: null });
  },

  getStatus: (username, filename) =>
    get().transfers.get(`${username}:${filename}`),
}));
```

- [ ] **Step 2: Start/stop polling in App.tsx**

In `packages/web/src/App.tsx`, add import:
```ts
import { useTransferStore } from '@/stores/transfers';
```

Add this `useEffect` after the existing `isAuthenticated`-gated effect (the one that calls `usePreserveStore.getState().init()`):
```ts
// Start/stop global transfer polling on auth state change
useEffect(() => {
  if (isAuthenticated) {
    useTransferStore.getState().startPolling();
  } else {
    useTransferStore.getState().stopPolling();
  }
}, [isAuthenticated]);
```

- [ ] **Step 3: Verify typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/stores/transfers.ts packages/web/src/App.tsx
git commit -m "feat(web): add global useTransferStore polling GET /api/downloads every 3s"
```

---

## Task 4: Migrate Downloads.tsx to use the store

**Files:**
- Modify: `packages/web/src/pages/Downloads.tsx`

Downloads.tsx currently maintains its own `downloads` state and polls every 3s via `fetchDownloads`. This task replaces that with reads from `useTransferStore`. The `hasActive` → auto-refresh-recent-songs chain is preserved because `downloads` stays the same type.

Note: `triggerScan` (around line 220) calls `window.setTimeout(fetchRecentSongs, 5000)` — this is unrelated to `fetchDownloads` and must not be changed.

- [ ] **Step 1: Add the store import**

In `packages/web/src/pages/Downloads.tsx`, add at the top with other imports:
```ts
import { useTransferStore } from '@/stores/transfers';
```

- [ ] **Step 2: Replace local downloads state + polling**

Remove:
```ts
const [downloads, setDownloads] = useState<Transfer[]>([]);

const fetchDownloads = useCallback(async () => {
  try {
    const data = (await api.getDownloads()) as Transfer[];
    setDownloads(data);
  } catch {
    /* ignore */
  }
}, []);

// Poll downloads every 3s
useEffect(() => {
  fetchDownloads();
  const interval = setInterval(fetchDownloads, 3000);
  return () => clearInterval(interval);
}, [fetchDownloads]);
```

Replace with:
```ts
const downloads = useTransferStore((s) => s.downloads) as Transfer[];
```

- [ ] **Step 3: Replace `fetchDownloads()` post-mutation calls**

In `clearGroup`, `clearAllFinished`, and `cancelAll`, replace every `fetchDownloads()` call with:
```ts
useTransferStore.getState().poll();
```

There are exactly three occurrences (one per function). Do not touch `fetchRecentSongs` anywhere.

- [ ] **Step 4: Clean up unused imports**

If `useCallback` is no longer used after removing `fetchDownloads`, remove it from the React import. `api.getDownloads` is also no longer called directly — remove it if unused (the store calls it internally).

- [ ] **Step 5: Verify typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/stores/transfers.ts packages/web/src/pages/Downloads.tsx
git commit -m "refactor(web): migrate Downloads page to useTransferStore, eliminate duplicate polling"
```

---

## Task 5: Create `downloadStatus.ts` utility — TDD

**Files:**
- Create: `packages/web/src/lib/downloadStatus.ts`
- Create: `packages/web/src/lib/downloadStatus.test.ts`

All imports in both files use relative paths — no `@/` aliases — so bun:test can resolve them without additional config.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/lib/downloadStatus.test.ts`:

```ts
import { describe, expect, it } from 'bun:test';
import {
  getSingleDownloadLabel,
  getFolderDownloadLabel,
  BUTTON_CLASSES,
} from './downloadStatus';
import type { TransferEntry } from './transferTypes';

const entry = (state: TransferEntry['state'], percent = 0): TransferEntry => ({ state, percent });

describe('getSingleDownloadLabel', () => {
  const noStatus = (_u: string, _f: string): TransferEntry | undefined => undefined;

  it('returns Download when no status and not queued', () => {
    const r = getSingleDownloadLabel('u', 'f', false, noStatus);
    expect(r.label).toBe('Download');
    expect(r.variant).toBe('default');
    expect(r.disabled).toBe(false);
  });

  it('returns Queued when optimistically queued but no transfer yet', () => {
    const r = getSingleDownloadLabel('u', 'f', true, noStatus);
    expect(r.label).toBe('Queued');
    expect(r.variant).toBe('queued');
    expect(r.disabled).toBe(true);
  });

  it('shows progress percent for InProgress', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('InProgress', 42));
    expect(r.label).toBe('↓ 42%');
    expect(r.variant).toBe('progress');
    expect(r.disabled).toBe(true);
  });

  it('shows progress for Initializing', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Initializing', 0));
    expect(r.variant).toBe('progress');
  });

  it('shows Queued for Queued, Locally', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Queued, Locally'));
    expect(r.label).toBe('Queued');
    expect(r.variant).toBe('queued');
  });

  it('shows Queued for Queued, Remotely', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Queued, Remotely'));
    expect(r.label).toBe('Queued');
  });

  it('shows Queued for Requested', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Requested'));
    expect(r.label).toBe('Queued');
  });

  it('shows Done for Completed, Succeeded', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Completed, Succeeded'));
    expect(r.label).toBe('✓ Done');
    expect(r.variant).toBe('done');
    expect(r.disabled).toBe(true);
  });

  it('shows Error for Completed, Errored', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Completed, Errored'));
    expect(r.label).toBe('✗ Error');
    expect(r.variant).toBe('error');
  });

  it('shows Error for Completed, Cancelled', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Completed, Cancelled'));
    expect(r.variant).toBe('error');
  });

  it('shows Error for Completed, TimedOut', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Completed, TimedOut'));
    expect(r.variant).toBe('error');
  });

  it('shows Error for Completed, Rejected', () => {
    const r = getSingleDownloadLabel('u', 'f', false, () => entry('Completed, Rejected'));
    expect(r.variant).toBe('error');
  });
});

describe('getFolderDownloadLabel', () => {
  it('returns Download folder when no files have status', () => {
    const files = [{ username: 'u', filename: 'a.mp3' }];
    const r = getFolderDownloadLabel(files, false, () => undefined);
    expect(r.label).toBe('Download folder');
    expect(r.variant).toBe('default');
  });

  it('returns Queued when isQueued is true and no transfer yet', () => {
    const files = [{ username: 'u', filename: 'a.mp3' }];
    const r = getFolderDownloadLabel(files, true, () => undefined);
    expect(r.label).toBe('Queued');
  });

  it('shows average progress across in-progress files', () => {
    const files = [
      { username: 'u', filename: 'a.mp3' },
      { username: 'u', filename: 'b.mp3' },
    ];
    const statuses: Record<string, TransferEntry> = {
      'u:a.mp3': entry('InProgress', 40),
      'u:b.mp3': entry('InProgress', 60),
    };
    const r = getFolderDownloadLabel(files, false, (u, f) => statuses[`${u}:${f}`]);
    expect(r.label).toBe('↓ 50%');
    expect(r.variant).toBe('progress');
  });

  it('error state wins over all others', () => {
    const files = [
      { username: 'u', filename: 'a.mp3' },
      { username: 'u', filename: 'b.mp3' },
    ];
    const statuses: Record<string, TransferEntry> = {
      'u:a.mp3': entry('Completed, Succeeded'),
      'u:b.mp3': entry('Completed, Errored'),
    };
    const r = getFolderDownloadLabel(files, false, (u, f) => statuses[`${u}:${f}`]);
    expect(r.variant).toBe('error');
  });

  it('returns Done only when all files succeeded', () => {
    const files = [
      { username: 'u', filename: 'a.mp3' },
      { username: 'u', filename: 'b.mp3' },
    ];
    const statuses: Record<string, TransferEntry> = {
      'u:a.mp3': entry('Completed, Succeeded'),
      'u:b.mp3': entry('Completed, Succeeded'),
    };
    const r = getFolderDownloadLabel(files, false, (u, f) => statuses[`${u}:${f}`]);
    expect(r.label).toBe('✓ Done');
    expect(r.variant).toBe('done');
  });

  it('does not return Done if only some files succeeded', () => {
    const files = [
      { username: 'u', filename: 'a.mp3' },
      { username: 'u', filename: 'b.mp3' },
    ];
    const statuses: Record<string, TransferEntry> = {
      'u:a.mp3': entry('Completed, Succeeded'),
    };
    const r = getFolderDownloadLabel(files, false, (u, f) => statuses[`${u}:${f}`]);
    expect(r.variant).not.toBe('done');
  });
});

describe('BUTTON_CLASSES', () => {
  it('exports a class string for every variant', () => {
    const variants = ['default', 'queued', 'progress', 'done', 'error'] as const;
    for (const v of variants) {
      expect(typeof BUTTON_CLASSES[v]).toBe('string');
      expect(BUTTON_CLASSES[v].length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `bun test packages/web/src/lib/downloadStatus.test.ts`
Expected: Fails with module-not-found for `./downloadStatus`

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/lib/downloadStatus.ts`:

```ts
import type { TransferEntry } from './transferTypes';

export type ButtonVariant = 'default' | 'queued' | 'progress' | 'done' | 'error';

export interface ButtonState {
  label: string;
  variant: ButtonVariant;
  disabled: boolean;
}

export const BUTTON_CLASSES: Record<ButtonVariant, string> = {
  default: 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700',
  queued:  'bg-zinc-700 text-zinc-400 opacity-75',
  progress:'bg-blue-900/60 text-blue-300',
  done:    'bg-green-900/60 text-green-300',
  error:   'bg-red-900/60 text-red-300',
};

export function getSingleDownloadLabel(
  username: string,
  filename: string,
  isQueued: boolean,
  getStatus: (username: string, filename: string) => TransferEntry | undefined,
): ButtonState {
  const e = getStatus(username, filename);

  if (!e) {
    if (isQueued) return { label: 'Queued', variant: 'queued', disabled: true };
    return { label: 'Download', variant: 'default', disabled: false };
  }

  const { state, percent } = e;

  if (state === 'InProgress' || state === 'Initializing')
    return { label: `↓ ${percent}%`, variant: 'progress', disabled: true };

  if (state === 'Queued, Locally' || state === 'Queued, Remotely' || state === 'Requested')
    return { label: 'Queued', variant: 'queued', disabled: true };

  if (state === 'Completed, Succeeded')
    return { label: '✓ Done', variant: 'done', disabled: true };

  // Completed, Cancelled / TimedOut / Errored / Rejected
  return { label: '✗ Error', variant: 'error', disabled: true };
}

/**
 * Derives folder-level button state by aggregating across all files.
 *
 * `files` must carry username per-item because network result file objects
 * don't include it (username lives on the parent result/group). The caller
 * must pre-map: `group.files.map(f => ({ username: group.username, filename: f.filename }))`.
 *
 * Note: FolderBrowser's "Download all" button has no optimistic-queued signal
 * because `addDownloading` lives in the search store and FolderBrowser doesn't
 * have access to it. The button will remain at its default state for up to one
 * poll cycle (~3s) after clicking. This is a known, acceptable gap.
 */
export function getFolderDownloadLabel(
  files: Array<{ username: string; filename: string }>,
  isQueued: boolean,
  getStatus: (username: string, filename: string) => TransferEntry | undefined,
): ButtonState {
  const entries = files
    .map((f) => getStatus(f.username, f.filename))
    .filter((e): e is TransferEntry => e !== undefined);

  // Any failure wins
  if (entries.some((e) => e.state.startsWith('Completed,') && e.state !== 'Completed, Succeeded'))
    return { label: '✗ Error', variant: 'error', disabled: true };

  // Average progress across in-flight files
  const inProgress = entries.filter((e) => e.state === 'InProgress' || e.state === 'Initializing');
  if (inProgress.length > 0) {
    const avg = Math.round(inProgress.reduce((s, e) => s + e.percent, 0) / inProgress.length);
    return { label: `↓ ${avg}%`, variant: 'progress', disabled: true };
  }

  // All known entries completed successfully
  if (entries.length > 0 && entries.every((e) => e.state === 'Completed, Succeeded'))
    return { label: '✓ Done', variant: 'done', disabled: true };

  // Optimistic or slskd-confirmed queued
  if (isQueued || entries.some((e) => e.state.includes('Queued') || e.state === 'Requested'))
    return { label: 'Queued', variant: 'queued', disabled: true };

  return { label: 'Download folder', variant: 'default', disabled: false };
}
```

- [ ] **Step 4: Run tests — confirm all pass**

Run: `bun test packages/web/src/lib/downloadStatus.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/downloadStatus.ts packages/web/src/lib/downloadStatus.test.ts
git commit -m "feat(web): add downloadStatus helpers with full test coverage (TDD)"
```

---

## Task 6: Bug fix + track button feedback in Search.tsx

**Files:**
- Modify: `packages/web/src/pages/Search.tsx`

- [ ] **Step 1: Add imports**

```ts
import { useTransferStore } from '@/stores/transfers';
import { getSingleDownloadLabel, BUTTON_CLASSES } from '@/lib/downloadStatus';
```

- [ ] **Step 2: Add `getStatus` in the component body**

Inside `SearchPage`, alongside the other store selectors near the top of the function:
```ts
const getStatus = useTransferStore((s) => s.getStatus);
```

- [ ] **Step 3: Fix size=0 guard in `handleDownload`**

The current `handleDownload` (starts with `async function handleDownload`):
```ts
// Add this guard as the very first line of the function body:
if (file.size === 0) return; // skip 0-byte directory stubs (Soulseek peer artifact)
```

Full replacement:
```ts
async function handleDownload(username: string, file: { filename: string; size: number }) {
  if (file.size === 0) return; // skip 0-byte directory stubs (Soulseek peer artifact)
  const key = `${username}:${file.filename}`;
  addDownloading(key);
  try {
    await api.enqueueDownload(username, [file]);
  } catch {
    // ignore
  }
}
```

- [ ] **Step 4: Replace the track download button**

Find the existing track Download button (the one with `{queued ? 'Queued' : 'Download'}`):
```tsx
<button
  onClick={() => handleDownload(file.username, { filename: file.filename, size: file.size })}
  disabled={queued}
  className="px-3 py-1 rounded-md text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition disabled:opacity-50"
>
  {queued ? 'Queued' : 'Download'}
</button>
```

Replace with:
```tsx
{(() => {
  const { label, variant, disabled } = getSingleDownloadLabel(
    file.username, file.filename,
    downloading.has(`${file.username}:${file.filename}`),
    getStatus,
  );
  return (
    <button
      onClick={() => handleDownload(file.username, { filename: file.filename, size: file.size })}
      disabled={disabled}
      className={`px-3 py-1 rounded-md text-xs font-medium transition ${BUTTON_CLASSES[variant]} ${disabled ? 'cursor-default' : ''}`}
    >
      {label}
    </button>
  );
})()}
```

Also remove the now-unused `const queued = downloading.has(key)` line inside the `.map()` if it only drove the old button.

- [ ] **Step 5: Verify typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/pages/Search.tsx
git commit -m "fix(web/search): filter size=0 stubs + wire track download buttons to live transfer status"
```

---

## Task 7: Folder button feedback in Search.tsx

**Files:**
- Modify: `packages/web/src/pages/Search.tsx`

- [ ] **Step 1: Update the downloadStatus import**

Change the existing import added in Task 6 to also include `getFolderDownloadLabel`:
```ts
import { getSingleDownloadLabel, getFolderDownloadLabel, BUTTON_CLASSES } from '@/lib/downloadStatus';
```

- [ ] **Step 2: Replace the folders view block**

Find the `{viewMode === 'folders' && ...}` section. Replace the entire contents of the `groupByDirectory(flatNetwork).map((group) => { ... })` callback with:

```tsx
{groupByDirectory(flatNetwork).map((group) => {
  const browserKey = `${group.username}::${group.directory}`;
  const isOpen = openBrowserKey === browserKey;
  const dirBasename = group.directory.split(/[\\/]/).at(-1) ?? group.directory;

  // Pre-map with username — network file objects don't carry it themselves
  const folderFiles = group.files.map((f) => ({
    username: group.username,
    filename: f.filename,
  }));
  const allOptimisticallyQueued = group.files.every((f) =>
    downloading.has(`${group.username}:${f.filename}`),
  );
  const folderBtn = getFolderDownloadLabel(folderFiles, allOptimisticallyQueued, getStatus);

  return (
    <div key={browserKey} className="mb-1">
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-zinc-800/50 transition">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-zinc-300 truncate">{dirBasename}</p>
          <p className="text-[11px] text-zinc-600 truncate">
            {group.username}
            {group.bitRate ? ` · ${group.bitRate} kbps` : ''}
            {` · ${group.files.length} files`}
          </p>
        </div>
        <button
          onClick={async () => {
            const validFiles = group.files.filter((f) => f.size > 0); // skip 0-byte stubs
            for (const f of validFiles) addDownloading(`${group.username}:${f.filename}`);
            await api.enqueueDownload(
              group.username,
              validFiles.map((f) => ({ filename: f.filename, size: f.size })),
            );
          }}
          disabled={folderBtn.disabled || group.files.filter((f) => f.size > 0).length === 0}
          className={`px-2 py-1 rounded text-xs font-medium transition shrink-0 ${BUTTON_CLASSES[folderBtn.variant]} ${folderBtn.disabled ? 'cursor-default' : ''}`}
        >
          {folderBtn.label}
        </button>
        {canBrowse && (
          <button
            onClick={() => setOpenBrowserKey(isOpen ? null : browserKey)}
            className="px-2 py-1 rounded text-xs text-zinc-500 hover:text-zinc-300 transition shrink-0"
          >
            {isOpen ? 'Close' : 'Browse library'}
          </button>
        )}
      </div>

      {isOpen && (
        <div className="mx-3 mb-2">
          <FolderBrowser
            username={group.username}
            matchedPath={group.directory}
            fallbackFiles={group.files.map((f) => ({
              filename: f.filename,
              size: f.size,
              bitRate: f.bitRate,
              length: f.length,
            }))}
            onDownload={async (files) => {
              const validFiles = files.filter((f) => f.size > 0); // skip 0-byte stubs
              for (const f of validFiles) addDownloading(`${group.username}:${f.filename}`);
              await api.enqueueDownload(group.username, validFiles);
            }}
            getStatus={getStatus}
          />
        </div>
      )}
    </div>
  );
})}
```

- [ ] **Step 3: Verify typecheck**

Run: `bun run typecheck`
Expected: Error about unknown `getStatus` prop on FolderBrowser — resolve in Task 8.

---

## Task 8: FolderBrowser — size filter + download status button

**Files:**
- Modify: `packages/web/src/components/FolderBrowser.tsx`

- [ ] **Step 1: Add imports**

In `packages/web/src/components/FolderBrowser.tsx`, add:
```ts
import { getFolderDownloadLabel, BUTTON_CLASSES } from '@/lib/downloadStatus';
import type { TransferEntry } from '@/lib/transferTypes';
```

- [ ] **Step 2: Add `getStatus` to props**

Update `FolderBrowserProps`:
```ts
interface FolderBrowserProps {
  username: string;
  matchedPath: string;
  fallbackFiles: BrowseFile[];
  onDownload: (files: Array<{ filename: string; size: number }>) => void;
  /** Optional: when provided, Download all button reflects live transfer status.
   *  Note: there is no optimistic "Queued" state for FolderBrowser — the button
   *  will update on the next poll cycle (~3s) after clicking. */
  getStatus?: (username: string, filename: string) => TransferEntry | undefined;
}
```

Destructure it in the component signature:
```ts
export function FolderBrowser({
  username,
  matchedPath,
  fallbackFiles,
  onDownload,
  getStatus,
}: FolderBrowserProps) {
```

- [ ] **Step 3: Replace the "Download all" button**

Find the existing button:
```tsx
<button
  onClick={() => onDownload(
    directFiles.map((f) => ({ filename: f.filename, size: f.size }))
  )}
  className="px-2 py-0.5 rounded text-[11px] font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition"
>
  Download all ({directFiles.length})
</button>
```

Replace with:
```tsx
{(() => {
  const validFiles = directFiles.filter((f) => f.size > 0); // skip 0-byte stubs
  const folderFiles = validFiles.map((f) => ({ username, filename: f.filename }));
  const btn = getStatus
    ? getFolderDownloadLabel(folderFiles, false, getStatus)
    : { label: `Download all (${validFiles.length})`, variant: 'default' as const, disabled: false };

  // When getFolderDownloadLabel returns 'Download folder' (default state),
  // use the more descriptive "Download all (N)" label instead.
  const displayLabel = btn.label === 'Download folder'
    ? `Download all (${validFiles.length})`
    : btn.label;

  return (
    <button
      onClick={() => onDownload(validFiles.map((f) => ({ filename: f.filename, size: f.size })))}
      disabled={btn.disabled || validFiles.length === 0}
      className={`px-2 py-0.5 rounded text-[11px] font-medium transition ${BUTTON_CLASSES[btn.variant]} ${btn.disabled ? 'cursor-default' : ''}`}
    >
      {displayLabel}
    </button>
  );
})()}
```

- [ ] **Step 4: Verify typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 5: Run all tests**

Run: `bun test packages/web/src/lib/downloadStatus.test.ts packages/web/src/lib/folderUtils.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit Tasks 7 + 8 together**

```bash
git add packages/web/src/pages/Search.tsx packages/web/src/components/FolderBrowser.tsx
git commit -m "feat(web): folder download size=0 filter + live status on folder and FolderBrowser buttons"
```

---

## Verification Checklist

1. **Ghost entry fix:** Download a folder from search → no phantom "track" named after the folder appears in the Downloads queue
2. **Track feedback:** Click Download on a track → button shows `Queued` → `↓ X%` while transferring → `✓ Done`
3. **Folder feedback:** Click `Download folder` → button shows aggregate `↓ X%` → `✓ Done` when all files finish
4. **FolderBrowser feedback:** Browse library → Download all → button shows `↓ X%` → `✓ Done` (with up to ~3s delay on initial "Queued" state — this is a known limitation)
5. **No duplicate polling:** Browser DevTools Network tab shows one `GET /api/downloads` per 3s, not two
6. **Navigation resilience:** Start a download, navigate to Library, return to Search → button still shows correct status (data lives in the global store, not component state)
7. **Unit tests:** `bun test packages/web/src/lib/downloadStatus.test.ts` → all pass
8. **Typecheck:** `bun run typecheck` → no errors

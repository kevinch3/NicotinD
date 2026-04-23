# NicotinD UI Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix search folder state loss and empty Downloads Active tab, remove the nav search bar, simplify remote playback to a clean on/off with auto-disable, and finish library granular routing by completing the library component.

**Architecture:** All changes are in `packages/web/src/app`. No backend or API changes. Each task is independent — they can be executed in any order and committed separately.

**Tech Stack:** Angular v22, signals, Tailwind CSS, vitest via `@angular/build:unit-test`

---

## File Map

| File | Change |
|------|--------|
| `services/search.service.ts` | Add `openBrowserKey` signal |
| `pages/search/search.component.ts` | Use `search.openBrowserKey` instead of local signal |
| `components/layout/layout.component.ts` | Inject TransferService, start/stop polling, remove search |
| `components/layout/layout.component.html` | Remove nav search forms |
| `pages/downloads/downloads.component.html` | Add empty state to Active tab |
| `services/playback-ws.service.ts` | Add failure tracking + `persistentFailure` signal |
| `services/remote-playback.service.ts` | Gate WS on toggle, add `disabledReason`, auto-disable effect |
| `components/player/player.component.html` | Wrap device-switcher in `@if (remote.remoteEnabled())` |
| `pages/settings/settings.component.html` | Show `disabledReason` banner |
| `pages/library/library.component.ts` | Add `getAlbumLink`/`getGenreLink`, remove all dead inline-detail code |

---

## Task 1: Bug — Persist search folder browser state across navigation

**Root cause:** `openBrowserKey = signal<string | null>(null)` lives in `SearchComponent`. Angular destroys and re-creates the component on every navigation, resetting it to `null`.

**Files:**
- Modify: `packages/web/src/app/services/search.service.ts`
- Modify: `packages/web/src/app/pages/search/search.component.ts`

- [ ] **Step 1: Add `openBrowserKey` signal to SearchService**

In `packages/web/src/app/services/search.service.ts`, add the signal right after `readonly history`:

```typescript
readonly openBrowserKey = signal<string | null>(null);
```

The `reset()` method should also clear it — add this line inside `reset()`:
```typescript
this.openBrowserKey.set(null);
```

Full updated `reset()`:
```typescript
reset(): void {
  this.network.set([]);
  this.networkState.set('idle');
  this.canBrowse.set(false);
  this.downloading.set(new Set());
  this.openBrowserKey.set(null);
}
```

- [ ] **Step 2: Remove local signal from SearchComponent and update references**

In `packages/web/src/app/pages/search/search.component.ts`:

Remove the local signal declaration (around line 145):
```typescript
// DELETE this line:
readonly openBrowserKey = signal<string | null>(null);
```

Every reference to `this.openBrowserKey` in the component becomes `this.search.openBrowserKey`. There are three locations:

In `executeSearch()` (the `openBrowserKey.set(null)` reset call):
```typescript
// BEFORE:
this.openBrowserKey.set(null);
// AFTER:
this.search.openBrowserKey.set(null);
```

In `toggleBrowser()`:
```typescript
// BEFORE:
toggleBrowser(key: string): void {
  this.openBrowserKey.update(k => k === key ? null : key);
}
// AFTER:
toggleBrowser(key: string): void {
  this.search.openBrowserKey.update(k => k === key ? null : key);
}
```

In the template, every `openBrowserKey()` reference becomes `search.openBrowserKey()`. Open `search.component.html` and replace all occurrences of `openBrowserKey()` with `search.openBrowserKey()`.

- [ ] **Step 3: Verify typecheck passes**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/app/services/search.service.ts \
        packages/web/src/app/pages/search/search.component.ts \
        packages/web/src/app/pages/search/search.component.html
git commit -m "fix: persist search folder browser state in SearchService across navigation"
```

---

## Task 2: Bug — Start TransferService polling + Downloads empty state

**Root cause:** `TransferService.startPolling()` is defined but never called. `downloads` signal is always `[]`.

**Files:**
- Modify: `packages/web/src/app/components/layout/layout.component.ts`
- Modify: `packages/web/src/app/pages/downloads/downloads.component.html`

- [ ] **Step 1: Inject TransferService into LayoutComponent and add polling lifecycle**

In `packages/web/src/app/components/layout/layout.component.ts`, add the following changes (do NOT remove `SearchService` or `FormsModule` yet — that happens in Task 3 once the HTML forms are also removed):

Add `OnInit, OnDestroy` to the Angular core imports:
```typescript
import { Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
```

Add `TransferService` import:
```typescript
import { TransferService } from '../../services/transfer.service';
```

Add `private transfers = inject(TransferService);` to the class injections (after the existing injections).

Add `implements OnInit, OnDestroy` to the class declaration:
```typescript
export class LayoutComponent implements OnInit, OnDestroy {
```

Add the lifecycle methods (anywhere in the class body, e.g. after the constructor):
```typescript
ngOnInit(): void {
  this.transfers.startPolling();
}

ngOnDestroy(): void {
  this.transfers.stopPolling();
}
```

- [ ] **Step 2: Add empty state to the Active tab in `downloads.component.html`**

After the closing `}` of the inner `@if` (after the `</section>` on line ~149), add an `@else` block inside the `activeTab === 'active'` guard:

Find this block (around lines 54–150):
```html
@if (activeTab() === 'active') {
@if (inProgressGroups().length > 0 || errorGroups().length > 0 || doneGroups().length > 0) {
  <section class="mb-8">
    ...
  </section>
}
} <!-- end activeTab === 'active' -->
```

Change it to:
```html
@if (activeTab() === 'active') {
  @if (inProgressGroups().length > 0 || errorGroups().length > 0 || doneGroups().length > 0) {
    <section class="mb-8">
      ... (existing section content unchanged) ...
    </section>
  } @else {
    <p class="text-center text-theme-muted text-sm py-20">No active downloads.</p>
  }
} <!-- end activeTab === 'active' -->
```

- [ ] **Step 3: Verify typecheck passes**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/app/components/layout/layout.component.ts \
        packages/web/src/app/pages/downloads/downloads.component.html
git commit -m "fix: start transfer polling from layout shell so active downloads and progress are visible"
```

---

## Task 3: Enh — Remove nav search bar

**Files:**
- Modify: `packages/web/src/app/components/layout/layout.component.html`
- Modify: `packages/web/src/app/components/layout/layout.component.ts`

Remove the HTML forms first, then clean up the now-unused `SearchService`, `FormsModule`, and `submitSearch` from the TS.

- [ ] **Step 1: Remove the desktop search form from the nav**

In `packages/web/src/app/components/layout/layout.component.html`, remove the entire desktop search block (lines ~24–36):

```html
<!-- DELETE this entire block: -->
<!-- Global search bar (desktop) -->
@if (!setup.isOffline()) {
  <form (submit)="submitSearch($event)" class="hidden md:flex items-center">
    <input
      type="text"
      [ngModel]="search.query()"
      (ngModelChange)="search.setQuery($event)"
      name="globalSearch"
      placeholder="Search…"
      class="w-52 lg:w-72 px-3 py-1.5 text-sm rounded-lg bg-theme-surface border border-theme text-theme-primary placeholder:text-theme-muted focus:outline-none focus:border-theme-accent transition"
    />
  </form>
}
```

- [ ] **Step 2: Remove the mobile drawer search section**

In the same file, remove the mobile drawer search block (lines ~74–87):

```html
<!-- DELETE this entire block: -->
<!-- Global search (mobile drawer) -->
<div class="px-4 py-3 border-b border-theme">
  <form (submit)="submitSearch($event)">
    <input
      type="text"
      [ngModel]="search.query()"
      (ngModelChange)="search.setQuery($event)"
      name="globalSearchMobile"
      placeholder="Search…"
      class="w-full px-3 py-2 text-sm rounded-lg bg-theme-surface-2 border border-theme text-theme-primary placeholder:text-theme-muted focus:outline-none focus:border-theme-accent transition"
    />
  </form>
</div>
```

- [ ] **Step 3: Clean up the TS — remove SearchService, FormsModule, submitSearch**

Now that the HTML forms are gone, `SearchService`, `FormsModule`, and `submitSearch()` are dead in `layout.component.ts`. Remove them:

Remove the `SearchService` import line:
```typescript
// DELETE:
import { SearchService } from '../../services/search.service';
```

Remove `FormsModule` from the Angular core imports and from the `@Component` imports array.

Remove `readonly search = inject(SearchService);` from the class body.

Remove the `submitSearch()` method:
```typescript
// DELETE:
submitSearch(event: Event): void {
  event.preventDefault();
  const q = this.search.query().trim();
  if (!q) return;
  this.search.setAutoSearch(true);
  this.router.navigate(['/']);
}
```

- [ ] **Step 4: Verify typecheck passes**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/components/layout/layout.component.html \
        packages/web/src/app/components/layout/layout.component.ts
git commit -m "feat: remove global nav search bar — search lives on the Search page"
```

---

## Task 4: Enh — PlaybackWsService: track connection failures

**Goal:** Expose a `persistentFailure` signal that is set after 5 consecutive connection failures (connection that never opened). This feeds into Task 5's auto-disable logic.

**Files:**
- Modify: `packages/web/src/app/services/playback-ws.service.ts`

- [ ] **Step 1: Add failure-tracking properties and signal**

In `playback-ws.service.ts`, add these three new private/public members after `private reconnectDelay = 1000;`:

```typescript
private didOpenSuccessfully = false;
private consecutiveFailures = 0;
readonly persistentFailure = signal<string | null>(null);
```

- [ ] **Step 2: Reset failure flag at the start of each connect attempt**

In the `connect()` method, add `this.didOpenSuccessfully = false;` immediately before `this.ws = new WebSocket(url);`:

```typescript
// Existing line before new WebSocket:
if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
// Add this:
this.didOpenSuccessfully = false;
this.ws = new WebSocket(url);
```

- [ ] **Step 3: Reset failure counters on successful open**

In the `this.ws.onopen` handler, add three lines at the top of the callback (before `this.reconnectDelay = 1000;`):

```typescript
this.ws.onopen = () => {
  this.didOpenSuccessfully = true;
  this.consecutiveFailures = 0;
  this.persistentFailure.set(null);
  this.reconnectDelay = 1000;
  // ... rest unchanged
};
```

- [ ] **Step 4: Count failures and stop reconnecting after threshold**

Replace the existing `this.ws.onclose` handler with:

```typescript
this.ws.onclose = () => {
  if (this.heartbeatTimer) {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
  if (!this.didOpenSuccessfully) {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 5) {
      this.persistentFailure.set(
        'Connection failed — remote playback may be unavailable in this environment',
      );
      return; // stop reconnecting
    }
  }
  if (localStorage.getItem('nicotind_token')) {
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }
};
```

- [ ] **Step 5: Add `clearPersistentFailure()` method**

Add this public method after `updateDevice()`:

```typescript
clearPersistentFailure(): void {
  this.persistentFailure.set(null);
  this.consecutiveFailures = 0;
}
```

- [ ] **Step 6: Verify typecheck passes**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/app/services/playback-ws.service.ts
git commit -m "feat: track consecutive WS connection failures in PlaybackWsService"
```

---

## Task 5: Enh — RemotePlaybackService: gate WS on toggle + auto-disable

**Files:**
- Modify: `packages/web/src/app/services/remote-playback.service.ts`

- [ ] **Step 1: Add `disabledReason` signal**

Add this signal after `readonly remoteEnabled`:

```typescript
/** Set when remote playback was automatically disabled due to connection failure */
readonly disabledReason = signal<string | null>(null);
```

- [ ] **Step 2: Update `setRemoteEnabled` to clear reason and WS failure state on re-enable**

Replace the existing `setRemoteEnabled` method with:

```typescript
setRemoteEnabled(enabled: boolean): void {
  if (enabled) {
    this.disabledReason.set(null);
    this.ws.clearPersistentFailure();
  }
  localStorage.setItem('nicotind_remote_enabled', String(enabled));
  this.ws.updateDevice({ remoteEnabled: enabled });
  this.remoteEnabled.set(enabled);
}
```

- [ ] **Step 3: Gate the WS connection effect on `remoteEnabled`**

Inside `initialize()`, replace the existing auth/WS effect:

```typescript
// BEFORE:
effect(() => {
  const token = this.auth.token();
  if (token) {
    this.ws.connect();
  } else {
    this.ws.disconnect();
  }
});

// AFTER:
effect(() => {
  const token = this.auth.token();
  const enabled = this.remoteEnabled();
  if (token && enabled) {
    this.ws.connect();
  } else {
    this.ws.disconnect();
  }
});
```

- [ ] **Step 4: Add auto-disable effect inside `initialize()`**

Add this new effect inside `initialize()`, after the auth effect:

```typescript
// Auto-disable when WS fails persistently
effect(() => {
  const reason = this.ws.persistentFailure();
  const enabled = this.remoteEnabled();
  if (reason && enabled) {
    untracked(() => {
      this.setRemoteEnabled(false);
      this.disabledReason.set(reason);
    });
  }
});
```

Make sure `untracked` is imported from `@angular/core` (add it to the existing import line).

- [ ] **Step 5: Verify typecheck passes**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/app/services/remote-playback.service.ts
git commit -m "feat: gate remote playback WS on toggle; auto-disable with reason on persistent failure"
```

---

## Task 6: Enh — Remote playback UI: gate device-switcher + show disabled reason

**Files:**
- Modify: `packages/web/src/app/components/player/player.component.html`
- Modify: `packages/web/src/app/pages/settings/settings.component.html`

- [ ] **Step 1: Wrap `<app-device-switcher />` in the player with a conditional**

In `packages/web/src/app/components/player/player.component.html`, find the right-side block (around line 138–142):

```html
<!-- BEFORE: -->
<!-- Right side: device switcher -->
<div class="flex items-center justify-end flex-shrink-0">
  <app-device-switcher />
</div>

<!-- AFTER: -->
<!-- Right side: device switcher -->
<div class="flex items-center justify-end flex-shrink-0">
  @if (remote.remoteEnabled()) {
    <app-device-switcher />
  }
</div>
```

The `remote` field is already injected in `PlayerComponent` (`private remote = inject(RemotePlaybackService)`). Change its visibility to `readonly` so the template can access it:

In `player.component.ts`, change:
```typescript
// BEFORE:
private remote = inject(RemotePlaybackService);
// AFTER:
readonly remote = inject(RemotePlaybackService);
```

- [ ] **Step 2: Show the disabled reason banner in Settings**

In `packages/web/src/app/pages/settings/settings.component.html`, find the Remote Playback section. After the closing `</div>` of the toggle row (around line 209, after the `@if (!remote.remoteEnabled())` block), add the auto-disabled reason notice:

```html
<!-- Add this block right after the toggle <div> that contains the switch button and its text -->
@if (remote.disabledReason()) {
  <div class="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="flex-shrink-0 mt-0.5">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
    <span>Remote playback was automatically disabled: {{ remote.disabledReason() }}</span>
  </div>
}
```

Insert it directly after the closing `</div>` of the first `<div class="flex items-start gap-3">` block (the toggle + text row), so it appears below the toggle description.

The exact insertion point is after line 208 (`</div>` that closes the toggle row), before the device name `<div>`:

```html
<!-- Context for insertion: -->
            </div>  <!-- closes the toggle row flex div -->
          </div>    <!-- closes space-y-5 -->

<!-- INSERT HERE (between the toggle row div and the device name div): -->
@if (remote.disabledReason()) {
  <div class="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="flex-shrink-0 mt-0.5">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
    <span>Remote playback was automatically disabled: {{ remote.disabledReason() }}</span>
  </div>
}
```

Read the file carefully before editing to find the exact insertion point. The `remote` service is already exposed as `readonly remote` on `SettingsComponent`, so `remote.disabledReason()` works directly in the template.

- [ ] **Step 3: Verify typecheck passes**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/app/components/player/player.component.html \
        packages/web/src/app/components/player/player.component.ts \
        packages/web/src/app/pages/settings/settings.component.html
git commit -m "feat: hide device switcher when remote playback disabled; show auto-disable reason in settings"
```

---

## Task 7: Feature — Complete library routing (add methods + remove dead inline-detail code)

**Context:** Routes are registered, `AlbumDetailComponent` and `GenreDetailComponent` are complete. The library HTML already uses `getAlbumLink()` and `getGenreLink()` — these methods just don't exist yet on the component. All inline album/genre detail state from the pre-routing era is dead code.

**Files:**
- Modify: `packages/web/src/app/pages/library/library.component.ts`

- [ ] **Step 1: Replace library.component.ts with the cleaned-up version**

Write the complete new content (the old file was ~307 lines; the new version is ~130 lines):

```typescript
import { Component, inject, signal, effect, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, type Album } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { TransferService } from '../../services/transfer.service';
import { ListControlsService, type SortOption } from '../../services/list-controls.service';
import { ListToolbarComponent } from '../../components/list-toolbar/list-toolbar.component';
import { resolveAlbumRoute, resolveGenreRoute } from '../../lib/route-utils';

type LibraryMode = 'albums' | 'artists' | 'genre';

@Component({
  selector: 'app-library',
  imports: [ListToolbarComponent, RouterLink],
  templateUrl: './library.component.html',
})
export class LibraryComponent implements OnInit {
  private api = inject(ApiService);
  readonly auth = inject(AuthService);
  private transferService = inject(TransferService);
  private listControls = inject(ListControlsService);

  // ─── Mode ─────────────────────────────────────────────────────────
  readonly modes = [
    { value: 'albums' as LibraryMode, label: 'Albums' },
    { value: 'artists' as LibraryMode, label: 'Artists' },
    { value: 'genre' as LibraryMode, label: 'Genre' },
  ];

  readonly libraryMode = signal<LibraryMode>(
    (localStorage.getItem('nicotind-library-mode') as LibraryMode) ?? 'albums',
  );

  setMode(mode: LibraryMode): void {
    this.libraryMode.set(mode);
    localStorage.setItem('nicotind-library-mode', mode);
    if (mode === 'artists' && !this.artists().length) this.fetchArtists();
    if (mode === 'genre' && !this.genres().length) this.fetchGenres();
  }

  // ─── Albums ───────────────────────────────────────────────────────
  readonly albums = signal<Album[]>([]);
  readonly loading = signal(true);

  readonly gridSortOptions: SortOption[] = [
    { field: 'name', label: 'Name' },
    { field: 'artist', label: 'Artist' },
    { field: 'year', label: 'Year' },
  ];

  readonly gridControls = this.listControls.connect({
    pageKey: 'library',
    items: this.albums,
    searchFields: ['name', 'artist'] as const,
    sortOptions: this.gridSortOptions,
  });

  // ─── Artists ──────────────────────────────────────────────────────
  readonly artists = signal<Array<{ id: string; name: string; albumCount: number; coverArt?: string }>>([]);
  readonly loadingArtists = signal(false);

  readonly artistSortOptions: SortOption[] = [
    { field: 'name', label: 'Name' },
    { field: 'albumCount', label: 'Albums' },
  ];

  readonly artistControls = this.listControls.connect({
    pageKey: 'library-artists',
    items: this.artists,
    searchFields: ['name'] as const,
    sortOptions: this.artistSortOptions,
    defaultSort: 'name',
  });

  // ─── Genre ────────────────────────────────────────────────────────
  readonly genres = signal<Array<{ value: string; songCount: number; albumCount: number }>>([]);
  readonly loadingGenres = signal(false);

  // ─── Lifecycle ────────────────────────────────────────────────────
  private dirtyEffect = effect(() => {
    if (this.transferService.libraryDirty()) {
      this.transferService.clearLibraryDirty();
      this.fetchAlbums();
    }
  });

  async ngOnInit(): Promise<void> {
    await this.fetchAlbums();
    const mode = this.libraryMode();
    if (mode === 'artists') this.fetchArtists();
    if (mode === 'genre') this.fetchGenres();
  }

  // ─── Route helpers ────────────────────────────────────────────────
  getAlbumLink(id: string): string[] { return resolveAlbumRoute(id); }
  getGenreLink(slug: string): string[] { return resolveGenreRoute(slug); }

  // ─── Artists methods ──────────────────────────────────────────────
  async fetchArtists(): Promise<void> {
    if (this.loadingArtists()) return;
    this.loadingArtists.set(true);
    try {
      const data = await firstValueFrom(this.api.getArtists());
      this.artists.set(data.map(a => ({ ...a, albumCount: a.albumCount ?? 0 })));
    } catch { /* ignore */ }
    finally { this.loadingArtists.set(false); }
  }

  // ─── Genre methods ────────────────────────────────────────────────
  async fetchGenres(): Promise<void> {
    if (this.loadingGenres()) return;
    this.loadingGenres.set(true);
    try {
      const data = await firstValueFrom(this.api.getGenres());
      this.genres.set(data.sort((a, b) => b.songCount - a.songCount));
    } catch { /* ignore */ }
    finally { this.loadingGenres.set(false); }
  }

  private async fetchAlbums(): Promise<void> {
    this.loading.set(true);
    try {
      const data = await firstValueFrom(this.api.getAlbums('newest', 80));
      this.albums.set(data);
    } catch { /* ignore */ }
    finally { this.loading.set(false); }
  }
}
```

- [ ] **Step 2: Verify typecheck passes**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck
```

Expected: no errors. If TypeScript complains about the `protected toTrackFn` that was in the old file, verify it was removed — it is not used in the new template.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/app/pages/library/library.component.ts
git commit -m "feat: complete library granular routing — add getAlbumLink/getGenreLink, remove dead inline-detail code"
```

---

## Post-implementation verification

After all tasks are committed, run a final typecheck and lint:

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck && bun run lint
```

The new untracked files (`album-detail.component.*`, `genre-detail.component.*`, `route-utils.*`) should be committed together if not already tracked:

```bash
git add packages/web/src/app/pages/library/album-detail.component.ts \
        packages/web/src/app/pages/library/album-detail.component.html \
        packages/web/src/app/pages/library/genre-detail.component.ts \
        packages/web/src/app/pages/library/genre-detail.component.html \
        packages/web/src/app/lib/route-utils.ts \
        packages/web/src/app/lib/route-utils.spec.ts
git commit -m "feat: add album-detail, genre-detail pages and route-utils for library deep linking"
```

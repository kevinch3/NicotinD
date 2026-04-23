# UI Consistency Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three visual bugs (search toolbar hidden behind icon, playlist/track titles illegible on light themes) and deliver two enhancements (Saved Offline UI parity with Recently Added, "Add to playlist" on all track lists).

**Architecture:** Pure UI layer — no API or backend changes. Schema change is limited to IndexedDB (add optional `bitRate` field, bump version to 2). New signals/methods added to existing page components rather than new services.

**Tech Stack:** Angular 22 standalone components, signals, Tailwind CSS v4 custom properties, IndexedDB via existing `preserve-store.ts`, Vitest unit tests.

---

## File Map

| File | Action | What changes |
|------|--------|--------------|
| `packages/web/src/app/services/list-controls.service.ts` | Modify | Remove `isToolbarVisible`, `showToolbar`, `hideToolbar` |
| `packages/web/src/app/services/list-controls.service.spec.ts` | Modify | Remove toolbar-state test if any; add none (no new behaviour) |
| `packages/web/src/app/components/list-toolbar/list-toolbar.component.ts` | Modify | Remove `dismiss` output |
| `packages/web/src/app/components/list-toolbar/list-toolbar.component.html` | Modify | Remove X button; replace all zinc colors with theme vars |
| `packages/web/src/app/pages/library/library.component.html` | Modify | Remove lupe buttons + `@if (isToolbarVisible())` gates; always render toolbar |
| `packages/web/src/app/pages/downloads/downloads.component.html` | Modify | Remove lupe button + gate for Recently Added; rewrite Saved Offline section |
| `packages/web/src/app/pages/downloads/downloads.component.ts` | Modify | Add offline tab signals/methods; widen `timeAgo` to accept `string \| number` |
| `packages/web/src/app/components/track-row/track-row.component.html` | Modify | Replace zinc colors with theme vars |
| `packages/web/src/app/pages/playlists/playlists.component.html` | Modify | Replace `text-zinc-100`/`text-zinc-200` with `text-theme-primary` |
| `packages/web/src/app/services/player.service.ts` | Modify | Add `bitRate?: number` to `Track` |
| `packages/web/src/app/lib/track-utils.ts` | Modify | Add `bitRate?: number` to `BaseSong`; propagate in `toTrack()` |
| `packages/web/src/app/lib/track-utils.spec.ts` | Modify | Add test: `toTrack` propagates `bitRate` |
| `packages/web/src/app/lib/preserve-store.ts` | Modify | Add `bitRate?: number` to `PreservedTrackMeta`; bump `DB_VERSION` to 2 |
| `packages/web/src/app/services/preserve.service.ts` | Modify | Capture `track.bitRate` in `preserve()` meta |
| `packages/web/src/app/pages/library/library.component.ts` | Modify | Add playlist picker signal/methods; extend action arrays; add `PlaylistAutocompleteComponent` import; extend `toTrackFromSong` inline type |
| `packages/web/src/app/pages/library/library.component.html` | Modify | Add `app-playlist-autocomplete` overlay |

---

## Task 1: Remove toolbar toggle — ListControlsService + ListToolbarComponent

**Files:**
- Modify: `packages/web/src/app/services/list-controls.service.ts`
- Modify: `packages/web/src/app/components/list-toolbar/list-toolbar.component.ts`
- Modify: `packages/web/src/app/components/list-toolbar/list-toolbar.component.html`

- [ ] **Step 1: Remove `isToolbarVisible`, `showToolbar`, `hideToolbar` from the `ListControls` interface and `ListControlsService` implementation**

Replace the full file `packages/web/src/app/services/list-controls.service.ts` with:

```typescript
import { Injectable, signal, computed, type Signal } from '@angular/core';

export interface SortOption {
  field: string;
  label: string;
}

interface PageState {
  searchText: string;
  sortField: string;
  sortDirection: 'asc' | 'desc';
}

const DEFAULT_STATE: PageState = {
  searchText: '',
  sortField: '',
  sortDirection: 'asc',
};

export interface ListControls<T> {
  filtered: Signal<T[]>;
  searchText: Signal<string>;
  sortField: Signal<string>;
  sortDirection: Signal<'asc' | 'desc'>;
  setSearchText(text: string): void;
  setSortField(field: string): void;
  toggleSortDirection(): void;
}

@Injectable({ providedIn: 'root' })
export class ListControlsService {
  private pages = signal<Record<string, PageState>>({});

  private getPage(pageKey: string): PageState {
    return this.pages()[pageKey] ?? DEFAULT_STATE;
  }

  private updatePage(pageKey: string, patch: Partial<PageState>): void {
    this.pages.update(pages => ({
      ...pages,
      [pageKey]: { ...(pages[pageKey] ?? DEFAULT_STATE), ...patch },
    }));
  }

  connect<T>(config: {
    pageKey: string;
    items: Signal<T[]>;
    searchFields: (keyof T)[];
    sortOptions: SortOption[];
    defaultSort?: string;
    defaultDirection?: 'asc' | 'desc';
  }): ListControls<T> {
    const { pageKey, items, searchFields, sortOptions, defaultSort, defaultDirection } = config;

    const current = this.getPage(pageKey);
    const isNewPage = !this.pages()[pageKey];
    if (!current.sortField && (defaultSort || sortOptions.length > 0)) {
      this.updatePage(pageKey, {
        sortField: defaultSort ?? sortOptions[0].field,
        ...(isNewPage && defaultDirection ? { sortDirection: defaultDirection } : {}),
      });
    } else if (isNewPage && defaultDirection) {
      this.updatePage(pageKey, { sortDirection: defaultDirection });
    }

    const searchText = computed(() => this.getPage(pageKey).searchText);
    const sortField = computed(() => this.getPage(pageKey).sortField);
    const sortDirection = computed(() => this.getPage(pageKey).sortDirection);

    const filtered = computed(() => {
      let result = [...items()];

      const query = searchText().toLowerCase().trim();
      if (query) {
        result = result.filter(item =>
          searchFields.some(field => {
            const value = item[field];
            if (value == null) return false;
            return String(value).toLowerCase().includes(query);
          }),
        );
      }

      const sf = sortField();
      if (sf) {
        const dir = sortDirection() === 'asc' ? 1 : -1;
        result.sort((a, b) => {
          const aVal = (a as Record<string, unknown>)[sf];
          const bVal = (b as Record<string, unknown>)[sf];
          if (aVal == null && bVal == null) return 0;
          if (aVal == null) return 1;
          if (bVal == null) return -1;
          if (typeof aVal === 'number' && typeof bVal === 'number') {
            return (aVal - bVal) * dir;
          }
          return String(aVal).localeCompare(String(bVal)) * dir;
        });
      }

      return result;
    });

    return {
      filtered,
      searchText,
      sortField,
      sortDirection,
      setSearchText: (text: string) => this.updatePage(pageKey, { searchText: text }),
      setSortField: (field: string) => this.updatePage(pageKey, { sortField: field }),
      toggleSortDirection: () => {
        const cur = this.getPage(pageKey);
        this.updatePage(pageKey, { sortDirection: cur.sortDirection === 'asc' ? 'desc' : 'asc' });
      },
    };
  }
}
```

- [ ] **Step 2: Remove `dismiss` output from `list-toolbar.component.ts`**

Replace `packages/web/src/app/components/list-toolbar/list-toolbar.component.ts` with:

```typescript
import { Component, input, output, viewChild, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';

export interface SortOption {
  field: string;
  label: string;
}

@Component({
  selector: 'app-list-toolbar',
  imports: [FormsModule],
  templateUrl: './list-toolbar.component.html',
  })
export class ListToolbarComponent {
  readonly inputEl = viewChild<ElementRef<HTMLInputElement>>('inputEl');

  readonly searchText = input('');
  readonly sortField = input('');
  readonly sortDirection = input<'asc' | 'desc'>('asc');
  readonly sortOptions = input<SortOption[]>([]);
  readonly resultCount = input<number | null>(null);

  readonly searchChange = output<string>();
  readonly sortFieldChange = output<string>();
  readonly toggleDirection = output<void>();

  focus(): void {
    this.inputEl()?.nativeElement.focus();
  }
}
```

- [ ] **Step 3: Replace `list-toolbar.component.html` — remove X button, apply theme vars**

Replace `packages/web/src/app/components/list-toolbar/list-toolbar.component.html` with:

```html

    <div class="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg bg-theme-surface border border-theme">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-theme-muted flex-shrink-0">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input #inputEl type="text" [ngModel]="searchText()" (ngModelChange)="searchChange.emit($event)"
        placeholder="Filter..." class="flex-1 min-w-0 bg-transparent text-sm text-theme-primary placeholder:text-theme-muted outline-none" />

      @if (resultCount() != null && searchText()) {
        <span class="text-xs text-theme-muted flex-shrink-0">{{ resultCount() }}</span>
      }

      <select [ngModel]="sortField()" (ngModelChange)="sortFieldChange.emit($event)"
        class="bg-theme-surface-2 border border-theme rounded text-xs text-theme-secondary px-2 py-1 outline-none cursor-pointer flex-shrink-0">
        @for (opt of sortOptions(); track opt.field) {
          <option [value]="opt.field">{{ opt.label }}</option>
        }
      </select>

      <button (click)="toggleDirection.emit()" class="p-1 text-theme-muted hover:text-theme-secondary transition flex-shrink-0"
        [title]="sortDirection() === 'asc' ? 'Ascending' : 'Descending'">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          [class]="sortDirection() === 'desc' ? 'rotate-180' : ''">
          <line x1="12" y1="19" x2="12" y2="5" />
          <polyline points="5 12 12 5 19 12" />
        </svg>
      </button>
    </div>
```

- [ ] **Step 4: Run type check to confirm no `dismiss`/`isToolbarVisible`/`showToolbar`/`hideToolbar` references remain**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck 2>&1 | head -60
```

Expected: errors only about places that still call the removed methods (will fix in Task 2).

- [ ] **Step 5: Commit**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD
git add packages/web/src/app/services/list-controls.service.ts \
        packages/web/src/app/components/list-toolbar/list-toolbar.component.ts \
        packages/web/src/app/components/list-toolbar/list-toolbar.component.html
git commit -m "refactor(web): remove toolbar toggle — list-toolbar always visible"
```

---

## Task 2: Remove lupe icon toggles from Library and Downloads

**Files:**
- Modify: `packages/web/src/app/pages/library/library.component.html`
- Modify: `packages/web/src/app/pages/downloads/downloads.component.html`

- [ ] **Step 1: Remove lupe button + `@if` gate for Album grid in `library.component.html`**

Find and replace in `packages/web/src/app/pages/library/library.component.html` — Album grid section (lines 94–112):

Old:
```html
          <!-- Album grid -->
          <div class="flex items-center gap-3 mb-4">
            <button (click)="gridControls.showToolbar()" class="p-1 text-theme-muted hover:text-theme-secondary transition" title="Search">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            </button>
          </div>

          @if (gridControls.isToolbarVisible()) {
            <app-list-toolbar
              [searchText]="gridControls.searchText()"
              [sortField]="gridControls.sortField()"
              [sortDirection]="gridControls.sortDirection()"
              [sortOptions]="gridSortOptions"
              [resultCount]="gridControls.filtered().length"
              (searchChange)="gridControls.setSearchText($event)"
              (sortFieldChange)="gridControls.setSortField($event)"
              (toggleDirection)="gridControls.toggleSortDirection()"
              (dismiss)="gridControls.hideToolbar()"
            />
          }
```

New:
```html
          <!-- Album grid -->
          <app-list-toolbar
            [searchText]="gridControls.searchText()"
            [sortField]="gridControls.sortField()"
            [sortDirection]="gridControls.sortDirection()"
            [sortOptions]="gridSortOptions"
            [resultCount]="gridControls.filtered().length"
            (searchChange)="gridControls.setSearchText($event)"
            (sortFieldChange)="gridControls.setSortField($event)"
            (toggleDirection)="gridControls.toggleSortDirection()"
          />
```

- [ ] **Step 2: Remove lupe button + `@if` gate for Artists section in `library.component.html`**

Old (lines 146–165):
```html
        <div class="flex items-center gap-3 mb-4">
          <button (click)="artistControls.showToolbar()"
            class="p-1 text-theme-muted hover:text-theme-secondary transition" title="Search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </button>
        </div>
        @if (artistControls.isToolbarVisible()) {
          <app-list-toolbar
            [searchText]="artistControls.searchText()"
            [sortField]="artistControls.sortField()"
            [sortDirection]="artistControls.sortDirection()"
            [sortOptions]="artistSortOptions"
            [resultCount]="artistControls.filtered().length"
            (searchChange)="artistControls.setSearchText($event)"
            (sortFieldChange)="artistControls.setSortField($event)"
            (toggleDirection)="artistControls.toggleSortDirection()"
            (dismiss)="artistControls.hideToolbar()"
          />
        }
```

New:
```html
        <app-list-toolbar
          [searchText]="artistControls.searchText()"
          [sortField]="artistControls.sortField()"
          [sortDirection]="artistControls.sortDirection()"
          [sortOptions]="artistSortOptions"
          [resultCount]="artistControls.filtered().length"
          (searchChange)="artistControls.setSearchText($event)"
          (sortFieldChange)="artistControls.setSortField($event)"
          (toggleDirection)="artistControls.toggleSortDirection()"
        />
```

- [ ] **Step 3: Remove `@if` gate for Album detail toolbar in `library.component.html`**

Old (lines 67–79):
```html
          @if (detailControls.isToolbarVisible()) {
            <app-list-toolbar
              [searchText]="detailControls.searchText()"
              [sortField]="detailControls.sortField()"
              [sortDirection]="detailControls.sortDirection()"
              [sortOptions]="detailSortOptions"
              [resultCount]="detailControls.filtered().length"
              (searchChange)="detailControls.setSearchText($event)"
              (sortFieldChange)="detailControls.setSortField($event)"
              (toggleDirection)="detailControls.toggleSortDirection()"
              (dismiss)="detailControls.hideToolbar()"
            />
          }
```

New:
```html
          <app-list-toolbar
            [searchText]="detailControls.searchText()"
            [sortField]="detailControls.sortField()"
            [sortDirection]="detailControls.sortDirection()"
            [sortOptions]="detailSortOptions"
            [resultCount]="detailControls.filtered().length"
            (searchChange)="detailControls.setSearchText($event)"
            (sortFieldChange)="detailControls.setSortField($event)"
            (toggleDirection)="detailControls.toggleSortDirection()"
          />
```

- [ ] **Step 4: Remove lupe button + `@if` gate for Recently Added in `downloads.component.html`**

Old (lines 217–242):
```html
            @if (recentSongs().length > 0) {
              <button (click)="recentControls.showToolbar()" class="p-1 text-theme-muted hover:text-theme-secondary transition" title="Search (Ctrl+F)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              </button>
            }
          </div>
          ...
        @if (recentControls.isToolbarVisible()) {
          <app-list-toolbar
            [searchText]="recentControls.searchText()"
            [sortField]="recentControls.sortField()"
            [sortDirection]="recentControls.sortDirection()"
            [sortOptions]="recentSortOptions"
            [resultCount]="recentControls.filtered().length"
            (searchChange)="recentControls.setSearchText($event)"
            (sortFieldChange)="recentControls.setSortField($event)"
            (toggleDirection)="recentControls.toggleSortDirection()"
            (dismiss)="recentControls.hideToolbar()"
          />
        }
```

Remove the lupe button block entirely. Replace the `@if (recentControls.isToolbarVisible())` block with an unconditional toolbar:

```html
        <app-list-toolbar
          [searchText]="recentControls.searchText()"
          [sortField]="recentControls.sortField()"
          [sortDirection]="recentControls.sortDirection()"
          [sortOptions]="recentSortOptions"
          [resultCount]="recentControls.filtered().length"
          (searchChange)="recentControls.setSearchText($event)"
          (sortFieldChange)="recentControls.setSortField($event)"
          (toggleDirection)="recentControls.toggleSortDirection()"
        />
```

- [ ] **Step 5: Run typecheck — should be clean**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck 2>&1 | head -40
```

Expected: 0 errors.

- [ ] **Step 6: Run tests**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD/packages/web && bun run test 2>&1 | tail -20
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD
git add packages/web/src/app/pages/library/library.component.html \
        packages/web/src/app/pages/downloads/downloads.component.html
git commit -m "feat(web): always show filter/sort toolbar in Library and Downloads"
```

---

## Task 3: Fix track-row and playlist zinc colors (theme bugs)

**Files:**
- Modify: `packages/web/src/app/components/track-row/track-row.component.html`
- Modify: `packages/web/src/app/pages/playlists/playlists.component.html`

- [ ] **Step 1: Replace all zinc colors in `track-row.component.html`**

Replace the full file with:

```html

    <div [class]="'flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-theme-hover transition group' + (disabled() ? ' opacity-40 pointer-events-none' : '')">
      <span class="text-xs text-theme-muted w-6 text-right">{{ indexLabel() ?? '' }}</span>
      @if (offline()) {
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" title="Saved offline"></span>
      }
      <app-cover-art
        [src]="track().coverArt ? '/api/cover/' + track().coverArt + '?size=40&token=' + auth.token() : undefined"
        [artist]="track().artist"
        [album]="track().album ?? ''"
        [size]="36"
        rounded="rounded"
      />
      <button type="button" (click)="play.emit()" class="flex-1 min-w-0 text-left">
        <p class="text-sm text-theme-primary truncate">{{ track().title }}</p>
        @if (subtitle()) {
          <p class="text-xs text-theme-muted truncate">{{ subtitle() }}</p>
        }
      </button>
      <span class="text-xs text-theme-muted">{{ formatDuration(duration() ?? track().duration) }}</span>
      <button type="button" (click)="play.emit()" class="p-1 text-theme-muted group-hover:text-theme-secondary transition flex-shrink-0" title="Play">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5,3 19,12 5,21" />
        </svg>
      </button>
      @if (showRemove()) {
        <button type="button" (click)="remove.emit()" class="p-1 text-theme-muted group-hover:text-theme-secondary hover:!text-red-400 transition flex-shrink-0" title="Remove">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      }
      @if (actions().length > 0) {
        <div class="relative flex-shrink-0">
          <button
            type="button"
            class="p-1 text-theme-muted group-hover:text-theme-secondary hover:!text-theme-primary transition"
            title="More options"
            (click)="toggleMenu($event)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
            </svg>
          </button>
          @if (menuOpen()) {
            <div class="absolute right-0 top-7 z-50 bg-theme-surface border border-theme rounded-xl shadow-xl py-1 min-w-40"
                 (click)="$event.stopPropagation()">
              @for (action of actions(); track action.label) {
                <button
                  type="button"
                  class="w-full text-left px-4 py-2 text-sm transition-colors hover:bg-theme-hover"
                  [class.text-red-400]="action.destructive"
                  [class.text-theme-secondary]="!action.destructive"
                  (click)="runAction(action)">
                  {{ action.label }}
                </button>
              }
            </div>
          }
        </div>
      }
    </div>
```

- [ ] **Step 2: Fix playlist title and card name colors in `playlists.component.html`**

Find and replace every occurrence of `text-zinc-100` and `text-zinc-200` that applies to playlist name text:

```bash
grep -n "text-zinc-100\|text-zinc-200" packages/web/src/app/pages/playlists/playlists.component.html
```

Replace line 23 (selected playlist title):
- Old: `class="text-2xl font-bold text-zinc-100"`
- New: `class="text-2xl font-bold text-theme-primary"`

Replace line 189 (playlist card name):
- Old: `class="text-sm text-zinc-200 truncate"`
- New: `class="text-sm text-theme-primary truncate"`

- [ ] **Step 3: Run typecheck + tests**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck 2>&1 | head -20
cd /home/kevinch3/Documentos/Dev/NicotinD/packages/web && bun run test 2>&1 | tail -10
```

Expected: 0 typecheck errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD
git add packages/web/src/app/components/track-row/track-row.component.html \
        packages/web/src/app/pages/playlists/playlists.component.html
git commit -m "fix(web): use theme vars for track-row and playlist title colors"
```

---

## Task 4: Add `bitRate` to `Track`, `BaseSong`, and `PreservedTrackMeta`

**Files:**
- Modify: `packages/web/src/app/services/player.service.ts`
- Modify: `packages/web/src/app/lib/track-utils.ts`
- Modify: `packages/web/src/app/lib/track-utils.spec.ts`
- Modify: `packages/web/src/app/lib/preserve-store.ts`
- Modify: `packages/web/src/app/services/preserve.service.ts`

- [ ] **Step 1: Write failing test for `toTrack` bitRate propagation**

Add to `packages/web/src/app/lib/track-utils.spec.ts` inside the `describe('toTrack')` block:

```typescript
    it('propagates bitRate to the track', () => {
      const song: BaseSong = { id: '7', title: 'T', artist: 'A', bitRate: 320 };
      expect(toTrack(song).bitRate).toBe(320);
    });

    it('leaves bitRate undefined when not provided', () => {
      const song: BaseSong = { id: '8', title: 'T', artist: 'A' };
      expect(toTrack(song).bitRate).toBeUndefined();
    });
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD/packages/web && bun run test 2>&1 | grep -A3 "bitRate"
```

Expected: TypeScript compile error — `bitRate` does not exist on `BaseSong`.

- [ ] **Step 3: Add `bitRate?: number` to `Track` in `player.service.ts`**

Old:
```typescript
export interface Track {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
  coverArt?: string;
  duration?: number;
}
```

New:
```typescript
export interface Track {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
  coverArt?: string;
  duration?: number;
  bitRate?: number;
}
```

- [ ] **Step 4: Add `bitRate?: number` to `BaseSong` and propagate in `toTrack()`**

Replace `packages/web/src/app/lib/track-utils.ts` with:

```typescript
import type { Track } from '../services/player.service';

export interface BaseSong {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
  coverArt?: string;
  duration?: number;
  bitRate?: number;
}

export function toTrack(song: BaseSong, fallbackAlbum?: string): Track {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    artistId: song.artistId,
    album: song.album ?? fallbackAlbum,
    coverArt: song.coverArt,
    duration: song.duration,
    bitRate: song.bitRate,
  };
}
```

- [ ] **Step 5: Run the test to confirm it passes**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD/packages/web && bun run test 2>&1 | grep -E "PASS|FAIL|bitRate"
```

Expected: both new tests pass.

- [ ] **Step 6: Add `bitRate?: number` to `PreservedTrackMeta` and bump `DB_VERSION` to 2**

In `packages/web/src/app/lib/preserve-store.ts`:

Change line 10:
```typescript
const DB_VERSION = 2;
```

Add `bitRate?: number` to the `PreservedTrackMeta` interface after `duration`:
```typescript
export interface PreservedTrackMeta {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverArt?: string;
  duration?: number;
  bitRate?: number;
  size: number;
  format: string;
  preservedAt: number;
  lastAccessedAt: number;
}
```

The `onupgradeneeded` callback creates object stores only when they don't exist — no structural migration needed for adding an optional field to a schemaless store.

- [ ] **Step 7: Capture `bitRate` when preserving a track in `preserve.service.ts`**

In the `preserve()` method, add `bitRate: track.bitRate` to the meta object:

Old:
```typescript
      const meta: PreservedTrackMeta = {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album ?? '',
        coverArt: track.coverArt,
        duration: track.duration,
        size: audioBlob.size,
        format: audioRes.headers.get('content-type') ?? 'audio/mpeg',
        preservedAt: now,
        lastAccessedAt: now,
      };
```

New:
```typescript
      const meta: PreservedTrackMeta = {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album ?? '',
        coverArt: track.coverArt,
        duration: track.duration,
        bitRate: track.bitRate,
        size: audioBlob.size,
        format: audioRes.headers.get('content-type') ?? 'audio/mpeg',
        preservedAt: now,
        lastAccessedAt: now,
      };
```

- [ ] **Step 8: Update `toTrackFromSong` inline type in `library.component.ts` to include `bitRate`**

Old (line 175):
```typescript
  toTrackFromSong(song: { id: string; title: string; artist: string; duration?: number; coverArt?: string }): Track {
```

New:
```typescript
  toTrackFromSong(song: { id: string; title: string; artist: string; duration?: number; coverArt?: string; bitRate?: number }): Track {
```

- [ ] **Step 9: Run typecheck + full test suite**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck 2>&1 | head -20
cd /home/kevinch3/Documentos/Dev/NicotinD/packages/web && bun run test 2>&1 | tail -15
```

Expected: 0 typecheck errors, all tests pass.

- [ ] **Step 10: Commit**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD
git add packages/web/src/app/services/player.service.ts \
        packages/web/src/app/lib/track-utils.ts \
        packages/web/src/app/lib/track-utils.spec.ts \
        packages/web/src/app/lib/preserve-store.ts \
        packages/web/src/app/services/preserve.service.ts \
        packages/web/src/app/pages/library/library.component.ts
git commit -m "feat(web): add bitRate to Track and PreservedTrackMeta; bump IndexedDB to v2"
```

---

## Task 5: Saved Offline — multiselect, bulk actions, full column layout

**Files:**
- Modify: `packages/web/src/app/pages/downloads/downloads.component.ts`
- Modify: `packages/web/src/app/pages/downloads/downloads.component.html`

- [ ] **Step 1: Widen `timeAgo` to accept `string | number` and add offline state to `downloads.component.ts`**

In `packages/web/src/app/pages/downloads/downloads.component.ts`:

**a)** Change the `timeAgo` helper function signature (lines 85–95):

```typescript
function timeAgo(date: string | number): string {
  const diff = Date.now() - (typeof date === 'number' ? date : new Date(date).getTime());
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}
```

**b)** Add offline tab signals and sort options after the `recentControls` block (around line 198):

```typescript
  // ─── Offline tab state ────────────────────────────────────────────
  readonly offlineSelected = signal(new Set<string>());
  readonly offlineSelectedArray = computed(() => Array.from(this.offlineSelected()));
  readonly offlineShowPlaylistPicker = signal(false);
  readonly addingOfflineToPlaylist = signal(false);
  readonly offlineMenuId = signal<string | null>(null);

  readonly offlineSortOptions: SortOption[] = [
    { field: 'preservedAt', label: 'Saved date' },
    { field: 'title', label: 'Title' },
    { field: 'artist', label: 'Artist' },
  ];

  readonly offlineControls = this.listControls.connect({
    pageKey: 'downloads-offline',
    items: this.preserve.preservedTracks,
    searchFields: ['title', 'artist', 'album'] as const,
    sortOptions: this.offlineSortOptions,
    defaultSort: 'preservedAt',
    defaultDirection: 'desc',
  });
```

**d)** Add methods for offline tab. Place after `clearAllPreserved()`:

```typescript
  selectAllOffline(): void {
    const all = this.offlineControls.filtered().map(t => t.id);
    if (this.offlineSelected().size === all.length) {
      this.offlineSelected.set(new Set());
    } else {
      this.offlineSelected.set(new Set(all));
    }
  }

  toggleOfflineSelect(id: string): void {
    this.offlineSelected.update(s => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async removeOfflineTracks(ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.preserve.remove(id);
    }
    this.offlineSelected.update(s => {
      const n = new Set(s);
      ids.forEach(id => n.delete(id));
      return n;
    });
  }

  async addOfflineToPlaylist(playlistId: string): Promise<void> {
    const songIds = Array.from(this.offlineSelected());
    this.addingOfflineToPlaylist.set(true);
    try {
      await firstValueFrom(this.api.updatePlaylist(playlistId, { songIdsToAdd: songIds }));
      this.offlineSelected.set(new Set());
      this.offlineShowPlaylistPicker.set(false);
    } catch { /* ignore */ }
    finally { this.addingOfflineToPlaylist.set(false); }
  }

  async createOfflinePlaylistAndAdd(name: string): Promise<void> {
    if (!name.trim()) return;
    const songIds = Array.from(this.offlineSelected());
    this.addingOfflineToPlaylist.set(true);
    try {
      await firstValueFrom(this.api.createPlaylist(name.trim(), songIds));
      this.offlineSelected.set(new Set());
      this.offlineShowPlaylistPicker.set(false);
    } catch { /* ignore */ }
    finally { this.addingOfflineToPlaylist.set(false); }
  }
```

**e)** Extend the existing `@HostListener('document:click') closeSongMenu()` to also close `offlineMenuId`:

```typescript
  @HostListener('document:click')
  closeSongMenu(): void {
    this.songMenuId.set(null);
    this.offlineMenuId.set(null);
  }
```

- [ ] **Step 2: Rewrite the Saved Offline section in `downloads.component.html`**

Replace the entire `<!-- Preserved (offline) section -->` block (from `@if (activeTab() === 'offline')` to its closing `}`) with:

```html
      <!-- Saved Offline tab -->
      @if (activeTab() === 'offline') {
        @if (preserve.preservedTracks().length > 0) {
          <section class="mb-8">
            <!-- Header -->
            <div class="flex items-center justify-between mb-3">
              <h2 class="text-xs font-semibold uppercase tracking-wider text-theme-muted">
                Saved Offline
                <span class="font-normal normal-case ml-1.5 text-theme-muted">
                  ({{ offlineControls.filtered().length }})
                </span>
              </h2>
              <button (click)="selectAllOffline()" class="text-xs text-theme-muted hover:text-theme-secondary transition">
                {{ offlineSelected().size === offlineControls.filtered().length ? 'Deselect all' : 'Select all' }}
              </button>
            </div>

            <!-- Storage bar -->
            <div class="mb-4 flex items-center gap-3">
              <div class="flex-1 h-1.5 bg-theme-surface-2 rounded-full overflow-hidden">
                <div class="h-full bg-emerald-500 rounded-full transition-all duration-500"
                  [style.width.%]="storagePercent()"></div>
              </div>
              <span class="text-xs text-theme-muted flex-shrink-0">
                {{ formatSize(preserve.totalUsage()) }} / {{ formatSize(preserve.budget()) }}
              </span>
            </div>

            <!-- Filter/sort toolbar -->
            <app-list-toolbar
              [searchText]="offlineControls.searchText()"
              [sortField]="offlineControls.sortField()"
              [sortDirection]="offlineControls.sortDirection()"
              [sortOptions]="offlineSortOptions"
              [resultCount]="offlineControls.filtered().length"
              (searchChange)="offlineControls.setSearchText($event)"
              (sortFieldChange)="offlineControls.setSortField($event)"
              (toggleDirection)="offlineControls.toggleSortDirection()"
            />

            <!-- Bulk action bar -->
            @if (offlineSelected().size > 0) {
              <div class="flex flex-wrap items-center gap-2 md:gap-3 px-3 md:px-4 py-2.5 mb-3 rounded-lg bg-theme-surface-2/60 border border-theme">
                <span class="text-sm text-theme-secondary font-medium">{{ offlineSelected().size }} selected</span>
                <div class="flex-1 min-w-0"></div>

                @if (offlineShowPlaylistPicker()) {
                  <div class="relative">
                    <app-playlist-autocomplete
                      (selected)="addOfflineToPlaylist($event); offlineShowPlaylistPicker.set(false)"
                      (create)="createOfflinePlaylistAndAdd($event)"
                    />
                  </div>
                }

                <button (click)="offlineShowPlaylistPicker.set(true)"
                  [disabled]="addingOfflineToPlaylist()"
                  class="text-xs px-3 py-1.5 rounded-lg bg-theme-surface hover:bg-theme-hover transition text-theme-secondary border border-theme disabled:opacity-50">
                  Add to playlist
                </button>
                <button (click)="removeOfflineTracks(offlineSelectedArray())"
                  class="text-xs px-3 py-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition border border-red-500/20">
                  Remove from device
                </button>
              </div>
            }

            <!-- Track list -->
            <div class="space-y-0.5">
              @for (track of offlineControls.filtered(); track track.id) {
                <div class="flex items-center gap-3 px-1.5 md:px-4 py-2.5 rounded-lg hover:bg-theme-surface-2/30 transition group">
                  <!-- Checkbox -->
                  <input type="checkbox"
                    [checked]="offlineSelected().has(track.id)"
                    (change)="toggleOfflineSelect(track.id)"
                    class="w-4 h-4 rounded flex-shrink-0 cursor-pointer accent-emerald-500" />
                  <!-- Track info -->
                  <div class="flex-1 min-w-0">
                    <p class="text-sm text-theme-primary truncate">{{ track.title }}</p>
                    <p class="text-xs text-theme-muted truncate">{{ track.artist }} · {{ track.album }}</p>
                  </div>
                  <!-- Bitrate -->
                  <span class="hidden md:inline text-xs text-theme-muted flex-shrink-0 w-12 text-right">
                    {{ track.bitRate ? track.bitRate + 'k' : '' }}
                  </span>
                  <!-- Duration -->
                  <span class="text-xs text-theme-muted flex-shrink-0 w-10 text-right">
                    {{ formatDuration(track.duration) }}
                  </span>
                  <!-- Saved date -->
                  <span class="hidden lg:inline text-xs text-theme-muted flex-shrink-0 w-20 text-right">
                    {{ timeAgo(track.preservedAt) }}
                  </span>
                  <!-- Remove button (hover) -->
                  <button (click)="removeOfflineTracks([track.id])"
                    class="p-1.5 text-theme-muted hover:text-red-400 transition flex-shrink-0 md:opacity-0 md:group-hover:opacity-100"
                    title="Remove from device">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                    </svg>
                  </button>
                  <!-- Context menu -->
                  <div class="relative flex-shrink-0">
                    <button
                      class="p-1.5 text-theme-muted hover:text-theme-secondary transition md:opacity-0 md:group-hover:opacity-100"
                      title="More options"
                      (click)="$event.stopPropagation(); offlineMenuId.set(offlineMenuId() === track.id ? null : track.id)">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/>
                      </svg>
                    </button>
                    @if (offlineMenuId() === track.id) {
                      <div class="absolute right-0 top-7 z-50 bg-theme-surface border border-theme rounded-xl shadow-xl py-1 min-w-40"
                           (click)="$event.stopPropagation()">
                        <button class="w-full text-left px-4 py-2 text-sm text-theme-secondary hover:bg-theme-hover transition-colors"
                          (click)="offlineMenuId.set(null); offlineSelected.update(s => new Set([...s, track.id])); offlineShowPlaylistPicker.set(true)">
                          Add to playlist
                        </button>
                        <button class="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-theme-hover transition-colors"
                          (click)="offlineMenuId.set(null); removeOfflineTracks([track.id])">
                          Remove from device
                        </button>
                      </div>
                    }
                  </div>
                </div>
              }
            </div>

            <!-- Clear all -->
            <div class="mt-3 flex justify-end">
              <button (click)="clearAllPreserved()"
                class="text-xs text-theme-muted hover:text-red-400 transition">
                Clear all
              </button>
            </div>
          </section>
        }
        @if (preserve.preservedTracks().length === 0) {
          <p class="text-center text-theme-muted py-20">No tracks saved offline yet.</p>
        }
      }
```

- [ ] **Step 3: Run typecheck**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck 2>&1 | head -30
```

Expected: 0 errors.

- [ ] **Step 4: Run tests**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD/packages/web && bun run test 2>&1 | tail -15
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD
git add packages/web/src/app/pages/downloads/downloads.component.ts \
        packages/web/src/app/pages/downloads/downloads.component.html
git commit -m "feat(web): Saved Offline — multiselect, bulk actions, bitrate/duration/date columns"
```

---

## Task 6: "Add to playlist" in Library (albums + genres)

**Files:**
- Modify: `packages/web/src/app/pages/library/library.component.ts`
- Modify: `packages/web/src/app/pages/library/library.component.html`

- [ ] **Step 1: Add `PlaylistAutocompleteComponent` to imports in `library.component.ts`**

Old import line:
```typescript
import { ListToolbarComponent } from '../../components/list-toolbar/list-toolbar.component';
import { TrackRowComponent, type TrackAction } from '../../components/track-row/track-row.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
```

New (add one line):
```typescript
import { ListToolbarComponent } from '../../components/list-toolbar/list-toolbar.component';
import { TrackRowComponent, type TrackAction } from '../../components/track-row/track-row.component';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { PlaylistAutocompleteComponent } from '../../components/playlist-autocomplete/playlist-autocomplete.component';
```

Also add `PlaylistAutocompleteComponent` to the `imports` array in the `@Component` decorator:

Old:
```typescript
  imports: [ListToolbarComponent, TrackRowComponent, ConfirmDialogComponent, RouterLink],
```

New:
```typescript
  imports: [ListToolbarComponent, TrackRowComponent, ConfirmDialogComponent, PlaylistAutocompleteComponent, RouterLink],
```

- [ ] **Step 2: Add playlist picker signals and methods to `library.component.ts`**

Add after the `showConfirm` computed signal block (around line 130):

```typescript
  // ─── Playlist picker ──────────────────────────────────────────────
  readonly playlistPickerSong = signal<{ id: string; title: string } | null>(null);
  readonly addingToPlaylistLib = signal(false);

  async addSongToPlaylist(playlistId: string): Promise<void> {
    const song = this.playlistPickerSong();
    if (!song) return;
    this.addingToPlaylistLib.set(true);
    try {
      await firstValueFrom(this.api.updatePlaylist(playlistId, { songIdsToAdd: [song.id] }));
      this.playlistPickerSong.set(null);
    } catch { /* ignore */ }
    finally { this.addingToPlaylistLib.set(false); }
  }

  async createLibraryPlaylistAndAdd(name: string): Promise<void> {
    const song = this.playlistPickerSong();
    if (!name.trim() || !song) return;
    this.addingToPlaylistLib.set(true);
    try {
      await firstValueFrom(this.api.createPlaylist(name.trim(), [song.id]));
      this.playlistPickerSong.set(null);
    } catch { /* ignore */ }
    finally { this.addingToPlaylistLib.set(false); }
  }
```

- [ ] **Step 3: Extend `albumTrackActions()` with "Add to playlist"**

Old:
```typescript
  albumTrackActions(song: { id: string; title: string; artistId?: string }): TrackAction[] {
    return [
      ...(song.artistId ? [{
        label: 'Go to artist',
        action: () => {
          void this.router.navigate(['/library', 'artists', song.artistId]);
        },
      }] : []),
      ...(this.auth.role() === 'admin' ? [{
        label: 'Remove',
        destructive: true,
        action: () => this.askConfirm(`Remove "${song.title}" from library?`, async () => {
          try { await firstValueFrom(this.api.deleteSongs([song.id])); } catch { /* ignore */ }
          this.selectedAlbum.update(a => a ? { ...a, song: a.song.filter(s => s.id !== song.id) } : null);
        }),
      }] : []),
    ];
  }
```

New:
```typescript
  albumTrackActions(song: { id: string; title: string; artistId?: string }): TrackAction[] {
    return [
      { label: 'Add to playlist', action: () => this.playlistPickerSong.set(song) },
      ...(song.artistId ? [{
        label: 'Go to artist',
        action: () => {
          void this.router.navigate(['/library', 'artists', song.artistId]);
        },
      }] : []),
      ...(this.auth.role() === 'admin' ? [{
        label: 'Remove',
        destructive: true,
        action: () => this.askConfirm(`Remove "${song.title}" from library?`, async () => {
          try { await firstValueFrom(this.api.deleteSongs([song.id])); } catch { /* ignore */ }
          this.selectedAlbum.update(a => a ? { ...a, song: a.song.filter(s => s.id !== song.id) } : null);
        }),
      }] : []),
    ];
  }
```

- [ ] **Step 4: Extend `genreTrackActions()` with "Add to playlist"**

Old:
```typescript
  genreTrackActions(song: Song): TrackAction[] {
    return [
      ...(song.artistId ? [{
        label: 'Go to artist',
        action: () => { void this.router.navigate(['/library', 'artists', song.artistId]); },
      }] : []),
      ...(this.auth.role() === 'admin' ? [{
        label: 'Remove',
        destructive: true,
        action: () => this.askConfirm(`Remove "${song.title}" from library?`, async () => {
          try { await firstValueFrom(this.api.deleteSongs([song.id])); } catch { /* ignore */ }
          this.genreSongs.update(s => s.filter(x => x.id !== song.id));
        }),
      }] : []),
    ];
  }
```

New:
```typescript
  genreTrackActions(song: Song): TrackAction[] {
    return [
      { label: 'Add to playlist', action: () => this.playlistPickerSong.set(song) },
      ...(song.artistId ? [{
        label: 'Go to artist',
        action: () => { void this.router.navigate(['/library', 'artists', song.artistId]); },
      }] : []),
      ...(this.auth.role() === 'admin' ? [{
        label: 'Remove',
        destructive: true,
        action: () => this.askConfirm(`Remove "${song.title}" from library?`, async () => {
          try { await firstValueFrom(this.api.deleteSongs([song.id])); } catch { /* ignore */ }
          this.genreSongs.update(s => s.filter(x => x.id !== song.id));
        }),
      }] : []),
    ];
  }
```

- [ ] **Step 5: Add playlist picker overlay to `library.component.html`**

Add the following just before the closing `</div>` of the root container (the `<div class="max-w-6xl mx-auto px-4 py-5 md:px-6 md:py-8">`):

```html
      <!-- Playlist picker overlay -->
      @if (playlistPickerSong()) {
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
             (click)="playlistPickerSong.set(null)">
          <div (click)="$event.stopPropagation()" class="bg-theme-surface rounded-xl shadow-xl p-4 w-80">
            <p class="text-sm text-theme-secondary mb-3 truncate">
              Add "{{ playlistPickerSong()!.title }}" to playlist
            </p>
            <app-playlist-autocomplete
              (selected)="addSongToPlaylist($event)"
              (create)="createLibraryPlaylistAndAdd($event)"
            />
          </div>
        </div>
      }
```

- [ ] **Step 6: Run typecheck**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck 2>&1 | head -30
```

Expected: 0 errors.

- [ ] **Step 7: Run tests**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD/packages/web && bun run test 2>&1 | tail -15
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD
git add packages/web/src/app/pages/library/library.component.ts \
        packages/web/src/app/pages/library/library.component.html
git commit -m "feat(web): add 'Add to playlist' action to Library album and genre track lists"
```

---

## Verification Checklist

After all tasks are complete:

- [ ] **Theme check** — Settings > Appearance: cycle through all 7 themes (Midnight, Daylight, Warm Paper, OLED, Twilight, Forest, E-Ink). Verify on each:
  - Playlist titles are readable (not blending into background)
  - Track row names are readable
  - The filter/sort toolbar background and text are readable

- [ ] **Search toolbar always visible** — navigate to: Library > Albums, Library > Artists, Library > Album detail (open any album), Downloads > Recently Added. Confirm the filter bar is visible immediately without clicking any icon.

- [ ] **Saved Offline parity** — save a track offline (player controls > save offline icon); navigate to Downloads > Saved Offline tab:
  - Checkbox appears per row
  - "Select all" / "Deselect all" works
  - Bitrate column shows (or is blank for older saved tracks)
  - Duration and saved date columns show
  - "Add to playlist" and "Remove from device" in bulk bar work
  - Context menu "..." appears on hover with same two actions

- [ ] **Add to playlist — Library** — open an album detail; click "..." on a track → "Add to playlist" appears → picker opens → selecting a playlist adds the track. Repeat for a genre track list.

- [ ] **IndexedDB version** — DevTools > Application > IndexedDB > `nicotind-preserve`: confirm version shows `2`. Pre-existing offline tracks load without errors (bitRate shows blank for them, that's expected).

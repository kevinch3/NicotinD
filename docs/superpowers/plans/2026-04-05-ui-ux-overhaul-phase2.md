# UI/UX Overhaul Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Downloads sort order, add a playlist autocomplete picker, add Artist/Genre library browse modes, add a "..." context menu to all track rows, enable playlist rename, make search always visible, and add confirmation dialogs for destructive actions.

**Architecture:** All changes are in `packages/web/src/app`. Shared components (`ConfirmDialogComponent`, `PlaylistAutocompleteComponent`) are added to `components/`. `TrackRowComponent` gains an `actions` input. Page components (Downloads, Library, Playlists) are updated to wire actions and switch to the new components. A new `ArtistDetailComponent` is added as a lazy-loaded route.

**Tech Stack:** Angular v22 standalone components, signals (`signal()`, `computed()`, `effect()`), `HttpClient`, Tailwind CSS, Angular Router.

---

## File Map

**New files:**
- `packages/web/src/app/components/confirm-dialog/confirm-dialog.component.ts`
- `packages/web/src/app/components/playlist-autocomplete/playlist-autocomplete.component.ts`
- `packages/web/src/app/pages/library/artist-detail.component.ts`

**Modified files:**
- `packages/web/src/app/components/track-row/track-row.component.ts` — add `actions` input + "..." menu
- `packages/web/src/app/services/api.service.ts` — add `getArtist()`, `getGenres()`, `getSongsByGenre()`
- `packages/web/src/app/pages/library/library.component.ts` — add mode switcher, Artists, Genre modes
- `packages/web/src/app/pages/downloads/downloads.component.ts` — flip to newest-first, swap playlist picker, add album remove
- `packages/web/src/app/pages/playlists/playlists.component.ts` — rename modal, always-visible search, newest-first, "..." menu
- `packages/web/src/app/app.routes.ts` — add `/library/artists/:id` route

---

## Task 1: `ConfirmDialogComponent`

**Files:**
- Create: `packages/web/src/app/components/confirm-dialog/confirm-dialog.component.ts`

- [ ] **Step 1: Create the component**

```typescript
// packages/web/src/app/components/confirm-dialog/confirm-dialog.component.ts
import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
         (click)="cancel.emit()" (keydown.escape)="cancel.emit()">
      <div class="bg-theme-surface border border-theme rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl"
           (click)="$event.stopPropagation()">
        <p class="text-theme-primary text-sm mb-6">{{ message() }}</p>
        <div class="flex gap-3 justify-end">
          <button
            class="px-4 py-2 text-sm text-theme-secondary hover:text-theme-primary rounded-lg transition-colors"
            (click)="cancel.emit()">
            Cancel
          </button>
          <button
            class="px-4 py-2 text-sm bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg transition-colors"
            (click)="confirm.emit()">
            {{ confirmLabel() }}
          </button>
        </div>
      </div>
    </div>
  `,
})
export class ConfirmDialogComponent {
  message = input.required<string>();
  confirmLabel = input<string>('Delete');
  confirm = output<void>();
  cancel = output<void>();
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/app/components/confirm-dialog/confirm-dialog.component.ts
git commit -m "feat: add ConfirmDialogComponent for destructive action confirmations"
```

---

## Task 2: Add `TrackAction` interface + "..." menu to `TrackRowComponent`

**Files:**
- Modify: `packages/web/src/app/components/track-row/track-row.component.ts`

- [ ] **Step 1: Read the current file**

Open `packages/web/src/app/components/track-row/track-row.component.ts` and note the current inputs, outputs, and template structure.

- [ ] **Step 2: Add `actions` input and context menu to the component**

Replace the full file content with the following (preserving all existing inputs/outputs and template, adding the `actions` input and "..." button):

```typescript
import { Component, input, output, signal, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CoverArtComponent } from '../cover-art/cover-art.component';

export interface TrackAction {
  label: string;
  icon?: string;
  action: () => void;
  destructive?: boolean;
}

@Component({
  selector: 'app-track-row',
  standalone: true,
  imports: [CommonModule, CoverArtComponent],
  template: `
    <div class="group flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-theme-hover transition-colors relative"
         [class.opacity-40]="disabled()" [class.pointer-events-none]="disabled()">

      <!-- Index label -->
      @if (indexLabel() !== undefined) {
        <span class="w-6 text-right text-xs text-theme-muted shrink-0 tabular-nums">
          {{ indexLabel() }}
        </span>
      }

      <!-- Cover art -->
      <app-cover-art
        [src]="track().coverArt"
        [artist]="track().artist"
        [album]="track().album ?? ''"
        [size]="36"
        className="shrink-0"
      />

      <!-- Title + subtitle -->
      <button
        class="flex-1 text-left min-w-0"
        (click)="play.emit()">
        <div class="text-sm text-theme-primary truncate">{{ track().title }}</div>
        @if (subtitle()) {
          <div class="text-xs text-theme-muted truncate">{{ subtitle() }}</div>
        }
      </button>

      <!-- Duration -->
      @if (duration() !== undefined) {
        <span class="text-xs text-theme-muted tabular-nums shrink-0">
          {{ formatDuration(duration()!) }}
        </span>
      }

      <!-- Action buttons row -->
      <div class="flex items-center gap-1 shrink-0">
        <!-- Play button (desktop hover) -->
        <button
          class="hidden md:flex opacity-0 group-hover:opacity-100 items-center justify-center w-7 h-7 rounded text-theme-secondary hover:text-theme-primary transition-all"
          (click)="play.emit()"
          title="Play">
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path d="M6.3 2.84A1.5 1.5 0 004 4.11v11.78a1.5 1.5 0 002.3 1.27l9.344-5.891a1.5 1.5 0 000-2.538L6.3 2.841z"/>
          </svg>
        </button>

        <!-- Remove button -->
        @if (showRemove()) {
          <button
            class="flex items-center justify-center w-7 h-7 rounded text-theme-muted hover:text-red-400 transition-colors"
            (click)="remove.emit()"
            title="Remove">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        }

        <!-- "..." context menu button -->
        @if (actions().length > 0) {
          <div class="relative">
            <button
              class="flex items-center justify-center w-7 h-7 rounded text-theme-muted hover:text-theme-primary transition-colors"
              (click)="toggleMenu($event)"
              title="More options">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z"/>
              </svg>
            </button>

            @if (menuOpen()) {
              <div class="absolute right-0 top-8 z-50 bg-theme-surface border border-theme rounded-xl shadow-xl py-1 min-w-40"
                   (click)="$event.stopPropagation()">
                @for (action of actions(); track action.label) {
                  <button
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
    </div>
  `,
})
export class TrackRowComponent {
  track = input.required<{ id: string; title: string; artist: string; album?: string; coverArt?: string; duration?: number }>();
  indexLabel = input<string | number | undefined>(undefined);
  subtitle = input<string | undefined>(undefined);
  duration = input<number | undefined>(undefined);
  disabled = input<boolean>(false);
  showRemove = input<boolean>(false);
  actions = input<TrackAction[]>([]);

  play = output<void>();
  remove = output<void>();

  menuOpen = signal(false);

  @HostListener('document:click')
  onDocumentClick() {
    this.menuOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    this.menuOpen.set(false);
  }

  toggleMenu(event: MouseEvent) {
    event.stopPropagation();
    this.menuOpen.update(v => !v);
  }

  runAction(action: TrackAction) {
    this.menuOpen.set(false);
    action.action();
  }

  formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
}
```

- [ ] **Step 3: Run typecheck**

```bash
cd /path/to/project && bun run typecheck
```

Expected: no errors related to `track-row.component.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/app/components/track-row/track-row.component.ts
git commit -m "feat: add TrackAction interface and context menu to TrackRowComponent"
```

---

## Task 3: Add `getArtist()`, `getGenres()`, `getSongsByGenre()` to `ApiService`

**Files:**
- Modify: `packages/web/src/app/services/api.service.ts`

- [ ] **Step 1: Read the current file around line 207 (after `getArtists()`)**

Note the exact closing brace of `getArtists()` at line ~209 to insert after it.

- [ ] **Step 2: Add three methods after `getArtists()`**

Insert after the `getArtists()` method (after line 209):

```typescript
  getArtist(id: string) {
    return this.http.get<{ artist: { id: string; name: string; albumCount: number; coverArt?: string }; albums: Album[] }>(
      `/api/library/artists/${id}`,
    );
  }

  getGenres() {
    return this.http.get<Array<{ value: string; songCount: number; albumCount: number }>>('/api/library/genres');
  }

  getSongsByGenre(genre: string, count = 100) {
    return this.http.get<Song[]>('/api/library/genres/songs', { params: { genre, count } });
  }
```

> Note: `getSongsByGenre` hits `/api/library/genres/songs` — verify the backend route in `packages/api/src/routes/library.ts`. The backend uses `GET /genres` + a separate `getSongsByGenre` call from the navidrome client. You may need to add a `GET /genres/songs?genre=X` route to the backend, or reuse `/songs/similar` approach. Check `library.ts` lines 141-143 — if only `/genres` exists, add the songs route (see Task 3b below).

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors in `api.service.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/app/services/api.service.ts
git commit -m "feat: add getArtist, getGenres, getSongsByGenre to ApiService"
```

---

## Task 3b: Add `GET /api/library/genres/songs` backend route (if missing)

**Files:**
- Modify: `packages/api/src/routes/library.ts`

- [ ] **Step 1: Check whether the route exists**

```bash
grep -n "genres/songs\|getSongsByGenre" packages/api/src/routes/library.ts
```

If output shows the route already exists, **skip this task entirely**.

- [ ] **Step 2: Add the route after the existing `/genres` route (around line 144)**

```typescript
  app.get('/genres/songs', async (c) => {
    const genre = c.req.query('genre') ?? '';
    const count = Number(c.req.query('count') ?? 100);
    if (!genre) return c.json([], 200);
    const songs = await navidrome.browsing.getSongsByGenre(genre, count);
    return c.json(songs);
  });
```

- [ ] **Step 3: Typecheck the API package**

```bash
bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/routes/library.ts
git commit -m "feat: add GET /api/library/genres/songs route"
```

---

## Task 4: `PlaylistAutocompleteComponent`

**Files:**
- Create: `packages/web/src/app/components/playlist-autocomplete/playlist-autocomplete.component.ts`

- [ ] **Step 1: Create the component**

```typescript
// packages/web/src/app/components/playlist-autocomplete/playlist-autocomplete.component.ts
import { Component, input, output, signal, computed, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { ApiService } from '../../services/api.service';
import { firstValueFrom } from 'rxjs';

interface PlaylistOption {
  id: string;
  name: string;
  coverArt?: string;
  artistHint: string;
}

@Component({
  selector: 'app-playlist-autocomplete',
  standalone: true,
  imports: [CommonModule, FormsModule, CoverArtComponent],
  template: `
    <div class="absolute z-50 bg-theme-surface border border-theme rounded-xl shadow-xl w-72 overflow-hidden"
         (click)="$event.stopPropagation()">
      <!-- Search input -->
      <div class="p-2 border-b border-theme">
        <input
          class="w-full bg-theme-surface-2 text-theme-primary text-sm px-3 py-1.5 rounded-lg outline-none placeholder:text-theme-muted"
          placeholder="Search playlists…"
          [(ngModel)]="query"
          autofocus
        />
      </div>

      <!-- Results -->
      <div class="max-h-56 overflow-y-auto">
        @if (loading()) {
          <div class="px-4 py-3 text-sm text-theme-muted">Loading…</div>
        } @else {
          @for (pl of filtered(); track pl.id) {
            <button
              class="w-full flex items-center gap-3 px-3 py-2 hover:bg-theme-hover transition-colors text-left"
              (click)="select(pl)">
              <app-cover-art
                [src]="pl.coverArt"
                [artist]="pl.artistHint"
                [album]="pl.name"
                [size]="32"
                className="shrink-0"
              />
              <div class="min-w-0">
                <div class="text-sm text-theme-primary truncate">{{ pl.name }}</div>
                @if (pl.artistHint) {
                  <div class="text-xs text-theme-muted truncate">{{ pl.artistHint }}</div>
                }
              </div>
            </button>
          }

          <!-- Create new -->
          @if (query().trim() && !exactMatch()) {
            <button
              class="w-full flex items-center gap-3 px-3 py-2 hover:bg-theme-hover transition-colors text-left border-t border-theme"
              (click)="createNew()">
              <div class="w-8 h-8 rounded flex items-center justify-center bg-theme-surface-2 shrink-0">
                <svg class="w-4 h-4 text-theme-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
                </svg>
              </div>
              <span class="text-sm text-theme-secondary">Create "{{ query().trim() }}"</span>
            </button>
          }

          @if (!loading() && filtered().length === 0 && !query().trim()) {
            <div class="px-4 py-3 text-sm text-theme-muted">No playlists yet</div>
          }
        }
      </div>
    </div>
  `,
})
export class PlaylistAutocompleteComponent implements OnInit {
  private api = inject(ApiService);

  selected = output<string>();  // playlist id
  create = output<string>();    // new playlist name

  query = signal('');
  loading = signal(true);
  playlists = signal<PlaylistOption[]>([]);

  filtered = computed(() => {
    const q = this.query().toLowerCase().trim();
    if (!q) return this.playlists();
    return this.playlists().filter(p => p.name.toLowerCase().includes(q));
  });

  exactMatch = computed(() =>
    this.playlists().some(p => p.name.toLowerCase() === this.query().toLowerCase().trim())
  );

  async ngOnInit() {
    const raw = await firstValueFrom(this.api.getPlaylists());
    this.playlists.set(raw.map(pl => ({
      id: pl.id,
      name: pl.name,
      coverArt: pl.coverArt,
      artistHint: '',  // Subsonic playlist API does not return track artist previews; left empty
    })));
    this.loading.set(false);
  }

  select(pl: PlaylistOption) {
    this.selected.emit(pl.id);
  }

  createNew() {
    this.create.emit(this.query().trim());
  }
}
```

> Note: The Subsonic playlist list endpoint (`GET /api/playlists`) returns `Playlist[]` which does not include track entries — so `artistHint` cannot be populated without fetching each playlist's full detail (expensive). The component leaves it empty for now. The cover art fallback gradient provides visual differentiation.

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/app/components/playlist-autocomplete/playlist-autocomplete.component.ts
git commit -m "feat: add PlaylistAutocompleteComponent"
```

---

## Task 5: Downloads — newest-first default + album remove + new playlist picker + "..." menu

**Files:**
- Modify: `packages/web/src/app/pages/downloads/downloads.component.ts`

This task has several sub-changes. Make them one at a time.

### 5a: Flip "Recently Added" default sort to newest-first

- [ ] **Step 1: Find the `ListControls` connection for `downloads-recent`**

In `downloads.component.ts`, around line 454, find:
```typescript
defaultDirection: 'desc'
```
This is already `desc` — verify it is set. If it is, **the sort is already newest-first** (since `defaultSort: 'created'` and `defaultDirection: 'desc'`). Confirm visually by checking the template sort toggle.

If `defaultDirection` is `'asc'`, change it to `'desc'`.

- [ ] **Step 2: Commit if changed**

```bash
git add packages/web/src/app/pages/downloads/downloads.component.ts
git commit -m "fix: default downloads recent sort to newest-first (desc)"
```

### 5b: Add `showConfirm` signal + `ConfirmDialogComponent` import

- [ ] **Step 1: Add confirm state signals near the top of the component class**

After the existing signals (around line 434), add:

```typescript
  confirmMessage = signal('');
  confirmCallback = signal<(() => void) | null>(null);
  showConfirm = computed(() => this.confirmCallback() !== null);
```

Add a helper method:

```typescript
  private askConfirm(message: string, cb: () => void) {
    this.confirmMessage.set(message);
    this.confirmCallback.set(cb);
  }

  onConfirm() {
    const cb = this.confirmCallback();
    this.confirmCallback.set(null);
    cb?.();
  }

  onCancelConfirm() {
    this.confirmCallback.set(null);
  }
```

- [ ] **Step 2: Add `ConfirmDialogComponent` to the component imports array**

```typescript
imports: [
  // ... existing imports ...
  ConfirmDialogComponent,
],
```

Add to TypeScript imports at top:
```typescript
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
```

- [ ] **Step 3: Add confirm dialog to the template**

At the bottom of the template (before the closing `</div>`), add:

```html
@if (showConfirm()) {
  <app-confirm-dialog
    [message]="confirmMessage()"
    confirmLabel="Remove"
    (confirm)="onConfirm()"
    (cancel)="onCancelConfirm()"
  />
}
```

### 5c: Replace flat playlist dropdown with `PlaylistAutocompleteComponent`

- [ ] **Step 1: Add `PlaylistAutocompleteComponent` to imports**

```typescript
import { PlaylistAutocompleteComponent } from '../../components/playlist-autocomplete/playlist-autocomplete.component';
```

Add to `imports` array in `@Component`.

- [ ] **Step 2: Find the template section for the playlist picker (around line 268–311)**

Replace the playlist picker section (the part showing `@if (showPlaylistPicker())` with the list of playlist buttons and inline creation input) with:

```html
@if (showPlaylistPicker()) {
  <div class="relative">
    <app-playlist-autocomplete
      (selected)="addToPlaylist($event)"
      (create)="createAndAdd($event)"
    />
  </div>
}
```

- [ ] **Step 3: Remove `playlists` and `newPlaylistName` signals** (they are no longer needed since the autocomplete component manages its own state)

Remove:
- `playlists = signal<PlaylistOption[]>([]);`
- `newPlaylistName = signal('');`
- The `openPlaylistPicker()` body that fetches playlists (keep the method but simplify to just `this.showPlaylistPicker.set(true)`)

- [ ] **Step 4: Run typecheck**

```bash
bun run typecheck
```

### 5d: Add "Remove album" button to album groups + "..." menu on track rows

- [ ] **Step 1: Add `removeGroup()` method**

```typescript
  removeGroup(group: AlbumGroup) {
    this.askConfirm(
      `Remove all ${group.totalFiles} file(s) in "${group.name}"?`,
      async () => {
        for (const fileId of group.fileIds) {
          const parts = group.key.split(':');
          const username = parts[0];
          await firstValueFrom(this.api.cancelDownload(username, fileId)).catch(() => {});
        }
      }
    );
  }
```

- [ ] **Step 2: Add trash button to each album group header in the template**

In the album group header section (around line 147–225), find the group header div and add a trash button:

```html
<button
  class="flex items-center justify-center w-7 h-7 rounded text-theme-muted hover:text-red-400 transition-colors"
  (click)="removeGroup(group)"
  title="Remove album">
  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
  </svg>
</button>
```

- [ ] **Step 3: Wire `TrackAction[]` for individual song rows in the recently-added section**

For each song row in the recently-added section (the `@for (song of ...)` loop in the template), pass actions to `app-track-row`:

```html
<app-track-row
  [track]="toTrack(song)"
  [subtitle]="song.artist"
  [duration]="song.duration"
  [actions]="songActions(song)"
  (play)="handlePlay(song)"
/>
```

Add a `songActions()` method:

```typescript
  songActions(song: Song): TrackAction[] {
    return [
      {
        label: 'Add to playlist',
        action: () => {
          this.selected.set(new Set([song.id]));
          this.showPlaylistPicker.set(true);
        },
      },
      {
        label: 'Remove',
        destructive: true,
        action: () => this.askConfirm(`Remove "${song.title}"?`, async () => {
          await firstValueFrom(this.api.deleteSong(song.id));
          this.recentSongs.update(s => s.filter(x => x.id !== song.id));
        }),
      },
      {
        label: 'Details',
        action: () => this.showSongDetails(song),
      },
    ];
  }
```

Add a minimal `showSongDetails()` stub for now (details panel is low-priority):

```typescript
  showSongDetails(song: Song) {
    // TODO Phase 3: show details panel
    alert(`${song.title}\n${song.path}\n${song.bitRate}kbps · ${song.suffix} · ${(song.size / 1024 / 1024).toFixed(1)}MB`);
  }
```

> Note: `alert()` is a placeholder — replace in Phase 3 with a proper details panel component.

Add import for `TrackAction`:
```typescript
import { TrackRowComponent, TrackAction } from '../../components/track-row/track-row.component';
```

- [ ] **Step 5: Run typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/app/pages/downloads/downloads.component.ts
git commit -m "feat: downloads — newest-first sort, autocomplete playlist picker, album remove, track context menu"
```

---

## Task 6: Library — mode switcher, Artists mode, Genre mode, album/track removal

**Files:**
- Modify: `packages/web/src/app/pages/library/library.component.ts`

### 6a: Add mode switcher + persist to localStorage

- [ ] **Step 1: Add `libraryMode` signal and mode switcher types**

At the top of the component class (after existing signals), add:

```typescript
  libraryMode = signal<'albums' | 'artists' | 'genre'>(
    (localStorage.getItem('nicotind-library-mode') as 'albums' | 'artists' | 'genre') ?? 'albums'
  );
```

Add an effect to persist the mode:

```typescript
  constructor() {
    effect(() => {
      localStorage.setItem('nicotind-library-mode', this.libraryMode());
    });
  }
```

- [ ] **Step 2: Add mode switcher to the template header**

In the library template, before the album grid section, add:

```html
<!-- Mode switcher -->
<div class="flex gap-1 p-1 bg-theme-surface-2 rounded-xl w-fit mb-4">
  @for (mode of [['albums','Albums'],['artists','Artists'],['genre','Genre']] ; track mode[0]) {
    <button
      class="px-4 py-1.5 text-sm rounded-lg transition-colors"
      [class.bg-theme-surface]="libraryMode() === mode[0]"
      [class.text-theme-primary]="libraryMode() === mode[0]"
      [class.text-theme-muted]="libraryMode() !== mode[0]"
      (click)="libraryMode.set($any(mode[0]))">
      {{ mode[1] }}
    </button>
  }
</div>
```

- [ ] **Step 3: Wrap existing album grid/detail in `@if (libraryMode() === 'albums')`**

Find the template section that renders the album grid and detail view. Wrap the entire block:

```html
@if (libraryMode() === 'albums') {
  <!-- existing album grid + detail template here -->
}
```

### 6b: Artists mode

- [ ] **Step 1: Add artists state signals**

```typescript
  artists = signal<Array<{ id: string; name: string; albumCount: number; coverArt?: string }>>([]);
  loadingArtists = signal(false);
```

- [ ] **Step 2: Add `fetchArtists()` method**

```typescript
  async fetchArtists() {
    if (this.artists().length) return;
    this.loadingArtists.set(true);
    const data = await firstValueFrom(this.api.getArtists());
    this.artists.set(data);
    this.loadingArtists.set(false);
  }
```

- [ ] **Step 3: Add `ListControls` for artists mode**

After the existing `listControls` connections, add:

```typescript
  artistControls = this.listControlsService.create({
    items: this.artists,
    pageKey: 'library-artists',
    searchFields: ['name'],
    sortOptions: [{ field: 'name', label: 'Name' }, { field: 'albumCount', label: 'Albums' }],
    defaultSort: 'name',
    defaultDirection: 'asc',
  });
```

- [ ] **Step 4: Add effect to fetch artists when mode switches**

```typescript
  private modeEffect = effect(() => {
    if (this.libraryMode() === 'artists') this.fetchArtists();
    if (this.libraryMode() === 'genre') this.fetchGenres();
  });
```

- [ ] **Step 5: Add Artists grid to the template**

```html
@if (libraryMode() === 'artists') {
  <div class="mb-4">
    <app-list-toolbar
      [searchText]="artistControls.searchText()"
      [sortField]="artistControls.sortField()"
      [sortDirection]="artistControls.sortDirection()"
      [sortOptions]="artistControls.sortOptions"
      (searchChange)="artistControls.setSearchText($event)"
      (sortFieldChange)="artistControls.setSortField($event)"
      (toggleDirection)="artistControls.toggleSortDirection()"
    />
  </div>
  @if (loadingArtists()) {
    <div class="text-theme-muted text-sm">Loading artists…</div>
  } @else {
    <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
      @for (artist of artistControls.filtered(); track artist.id) {
        <button
          class="flex flex-col items-center gap-2 p-3 rounded-xl hover:bg-theme-hover transition-colors text-center"
          [routerLink]="['/library', 'artists', artist.id]">
          <app-cover-art
            [src]="artist.coverArt"
            [artist]="artist.name"
            album=""
            [size]="80"
            className="w-20 h-20 rounded-full"
          />
          <div class="min-w-0 w-full">
            <div class="text-sm text-theme-primary truncate">{{ artist.name }}</div>
            <div class="text-xs text-theme-muted">{{ artist.albumCount }} album{{ artist.albumCount !== 1 ? 's' : '' }}</div>
          </div>
        </button>
      }
    </div>
  }
}
```

Add `RouterLink` to the component imports:
```typescript
import { RouterLink } from '@angular/router';
```

### 6c: Genre mode

- [ ] **Step 1: Add genre state signals**

```typescript
  genres = signal<Array<{ value: string; songCount: number; albumCount: number }>>([]);
  loadingGenres = signal(false);
  selectedGenre = signal<string | null>(null);
  genreSongs = signal<Song[]>([]);
  loadingGenreSongs = signal(false);
```

- [ ] **Step 2: Add `fetchGenres()` and `openGenre()` methods**

```typescript
  async fetchGenres() {
    if (this.genres().length) return;
    this.loadingGenres.set(true);
    const data = await firstValueFrom(this.api.getGenres());
    this.genres.set(data.sort((a, b) => b.songCount - a.songCount));
    this.loadingGenres.set(false);
  }

  async openGenre(genre: string) {
    this.selectedGenre.set(genre);
    this.loadingGenreSongs.set(true);
    const songs = await firstValueFrom(this.api.getSongsByGenre(genre));
    this.genreSongs.set(songs);
    this.loadingGenreSongs.set(false);
  }
```

- [ ] **Step 3: Add Genre grid + track list to the template**

```html
@if (libraryMode() === 'genre') {
  @if (!selectedGenre()) {
    @if (loadingGenres()) {
      <div class="text-theme-muted text-sm">Loading genres…</div>
    } @else {
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        @for (genre of genres(); track genre.value) {
          <button
            class="flex flex-col items-start gap-1 p-4 rounded-xl bg-theme-surface hover:bg-theme-hover transition-colors border border-theme text-left"
            (click)="openGenre(genre.value)">
            <div class="text-sm text-theme-primary font-medium truncate w-full">{{ genre.value }}</div>
            <div class="text-xs text-theme-muted">{{ genre.songCount }} tracks</div>
          </button>
        }
      </div>
    }
  } @else {
    <!-- Genre track list -->
    <div class="flex items-center gap-3 mb-4">
      <button class="text-theme-secondary hover:text-theme-primary text-sm" (click)="selectedGenre.set(null)">
        ← Back
      </button>
      <h2 class="text-theme-primary font-medium">{{ selectedGenre() }}</h2>
    </div>
    @if (loadingGenreSongs()) {
      <div class="text-theme-muted text-sm">Loading…</div>
    } @else {
      @for (song of genreSongs(); track song.id) {
        <app-track-row
          [track]="toTrack(song)"
          [subtitle]="song.artist + ' · ' + song.album"
          [duration]="song.duration"
          [actions]="libraryTrackActions(song)"
          (play)="playSong(song)"
        />
      }
    }
  }
}
```

### 6d: Album & track removal

- [ ] **Step 1: Add `ConfirmDialogComponent` import and confirm signals**

```typescript
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import { TrackRowComponent, TrackAction } from '../../components/track-row/track-row.component';
```

Add to `imports` array.

Add signals:
```typescript
  confirmMessage = signal('');
  confirmCallback = signal<(() => void) | null>(null);
  showConfirm = computed(() => this.confirmCallback() !== null);

  private askConfirm(message: string, cb: () => void) {
    this.confirmMessage.set(message);
    this.confirmCallback.set(cb);
  }

  onConfirm() {
    const cb = this.confirmCallback();
    this.confirmCallback.set(null);
    cb?.();
  }

  onCancelConfirm() {
    this.confirmCallback.set(null);
  }
```

- [ ] **Step 2: Add `libraryTrackActions()` method**

```typescript
  libraryTrackActions(song: { id: string; title: string; artist: string; artistId?: string; albumId?: string }): TrackAction[] {
    return [
      {
        label: 'Add to playlist',
        action: () => { /* TODO: wire PlaylistAutocompleteComponent — see Task 6e */ },
      },
      {
        label: 'Go to artist',
        action: () => this.router.navigate(['/library', 'artists', song.artistId]),
      },
      {
        label: 'Go to album',
        action: () => {
          // Navigate back to library albums mode and open album
          this.libraryMode.set('albums');
          if (song.albumId) this.openAlbum({ id: song.albumId } as any);
        },
      },
      {
        label: 'Remove',
        destructive: true,
        action: () => this.askConfirm(`Remove "${song.title}" from library?`, async () => {
          await firstValueFrom(this.api.deleteSong(song.id));
          // Refresh current view
          if (this.selectedAlbum()) {
            const updated = await firstValueFrom(this.api.getAlbum(this.selectedAlbum()!.id));
            this.selectedAlbum.set(updated);
          }
          this.genreSongs.update(s => s.filter(x => x.id !== song.id));
        }),
      },
    ];
  }
```

Inject `Router`:
```typescript
import { Router } from '@angular/router';
// in constructor or via inject():
private router = inject(Router);
```

- [ ] **Step 3: Add "Remove album" button to album detail view header**

In the album detail view section (when `selectedAlbum()` is shown), find the header area and add:

```html
<button
  class="flex items-center gap-2 px-3 py-1.5 text-sm text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
  (click)="removeAlbum()">
  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
  </svg>
  Remove album
</button>
```

Add `removeAlbum()`:

```typescript
  removeAlbum() {
    const album = this.selectedAlbum();
    if (!album) return;
    this.askConfirm(`Remove all tracks in "${album.name}"?`, async () => {
      for (const song of album.song ?? []) {
        await firstValueFrom(this.api.deleteSong(song.id)).catch(() => {});
      }
      this.selectedAlbum.set(null);
      await this.fetchAlbums();
    });
  }
```

- [ ] **Step 4: Update existing `app-track-row` usages in album detail to pass `actions`**

In the album detail track list, update each `<app-track-row>`:

```html
<app-track-row
  [track]="toTrack(song, selectedAlbum()?.name)"
  [indexLabel]="song.track"
  [duration]="song.duration"
  [actions]="libraryTrackActions(song)"
  (play)="playSong(song)"
/>
```

- [ ] **Step 5: Add confirm dialog to library template**

```html
@if (showConfirm()) {
  <app-confirm-dialog
    [message]="confirmMessage()"
    confirmLabel="Remove"
    (confirm)="onConfirm()"
    (cancel)="onCancelConfirm()"
  />
}
```

- [ ] **Step 6: Add artist link to album detail header**

In the album detail header, make the artist name a link:

```html
<a
  class="text-sm text-theme-secondary hover:text-theme-primary transition-colors cursor-pointer"
  [routerLink]="['/library', 'artists', selectedAlbum()?.artistId]"
  (click)="libraryMode.set('albums')">
  {{ selectedAlbum()?.artist }}
</a>
```

> Note: `artistId` needs to be present on `AlbumDetail`. Check `api.service.ts` Album interface — it has `artistId: string` from the core types. If the `getAlbum` response includes it, this works directly.

- [ ] **Step 7: Run typecheck**

```bash
bun run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/app/pages/library/library.component.ts
git commit -m "feat: library — Artists/Genre modes, track/album removal, mode switcher, artist links"
```

---

## Task 7: `ArtistDetailComponent` + route

**Files:**
- Create: `packages/web/src/app/pages/library/artist-detail.component.ts`
- Modify: `packages/web/src/app/app.routes.ts`

- [ ] **Step 1: Create the Artist Detail component**

```typescript
// packages/web/src/app/pages/library/artist-detail.component.ts
import { Component, inject, signal, OnInit } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { ApiService } from '../../services/api.service';
import { CoverArtComponent } from '../../components/cover-art/cover-art.component';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-artist-detail',
  standalone: true,
  imports: [CommonModule, RouterLink, CoverArtComponent],
  template: `
    <div class="p-4 max-w-5xl mx-auto">
      <!-- Back -->
      <button
        class="text-theme-secondary hover:text-theme-primary text-sm mb-4 flex items-center gap-1"
        (click)="router.navigate(['/library'])">
        ← Library
      </button>

      @if (loading()) {
        <div class="text-theme-muted text-sm">Loading…</div>
      } @else if (artist()) {
        <div class="mb-6 flex items-center gap-4">
          <app-cover-art
            [src]="artist()!.coverArt"
            [artist]="artist()!.name"
            album=""
            [size]="72"
            className="rounded-full shrink-0"
          />
          <div>
            <h1 class="text-2xl font-bold text-theme-primary">{{ artist()!.name }}</h1>
            <div class="text-theme-muted text-sm">{{ albums().length }} album{{ albums().length !== 1 ? 's' : '' }}</div>
          </div>
        </div>

        <!-- Albums grid -->
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          @for (album of albums(); track album.id) {
            <a
              class="flex flex-col gap-2 p-2 rounded-xl hover:bg-theme-hover transition-colors cursor-pointer"
              [routerLink]="['/library']"
              [queryParams]="{ album: album.id }">
              <app-cover-art
                [src]="album.coverArt"
                [artist]="album.artist"
                [album]="album.name"
                [size]="120"
                className="w-full aspect-square rounded-lg"
              />
              <div>
                <div class="text-sm text-theme-primary truncate">{{ album.name }}</div>
                @if (album.year) {
                  <div class="text-xs text-theme-muted">{{ album.year }}</div>
                }
              </div>
            </a>
          }
        </div>
      }
    </div>
  `,
})
export class ArtistDetailComponent implements OnInit {
  private route = inject(ActivatedRoute);
  router = inject(Router);
  private api = inject(ApiService);

  loading = signal(true);
  artist = signal<{ id: string; name: string; albumCount: number; coverArt?: string } | null>(null);
  albums = signal<Array<{ id: string; name: string; artist: string; coverArt?: string; year?: number }>>([]);

  async ngOnInit() {
    const id = this.route.snapshot.paramMap.get('id')!;
    const data = await firstValueFrom(this.api.getArtist(id));
    this.artist.set(data.artist);
    this.albums.set(data.albums);
    this.loading.set(false);
  }
}
```

> Note: The artist detail links albums back to `/library?album=<id>`. The `LibraryComponent` does not currently read query params to auto-open an album. Task 7b adds that support.

- [ ] **Step 2: Add route to `app.routes.ts`**

Read current `app.routes.ts`. Add the new route inside the authenticated layout children array:

```typescript
{
  path: 'library/artists/:id',
  loadComponent: () =>
    import('./pages/library/artist-detail.component').then(m => m.ArtistDetailComponent),
},
```

Place it after the `'library'` route entry.

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/app/pages/library/artist-detail.component.ts
git add packages/web/src/app/app.routes.ts
git commit -m "feat: add ArtistDetailComponent and /library/artists/:id route"
```

---

## Task 7b: Library — open album from query param (for artist detail deep-link)

**Files:**
- Modify: `packages/web/src/app/pages/library/library.component.ts`

- [ ] **Step 1: Read query params on init**

Inject `ActivatedRoute` and add an `OnInit` hook (or extend the existing one if present):

```typescript
import { ActivatedRoute } from '@angular/router';
// inject:
private route = inject(ActivatedRoute);
```

In `ngOnInit()` (or constructor effect):

```typescript
  async ngOnInit() {
    await this.fetchAlbums();
    const albumId = this.route.snapshot.queryParamMap.get('album');
    if (albumId) {
      const detail = await firstValueFrom(this.api.getAlbum(albumId));
      this.selectedAlbum.set(detail);
    }
  }
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/app/pages/library/library.component.ts
git commit -m "feat: library — open album from ?album= query param (artist deep-link)"
```

---

## Task 8: Playlists — rename modal, always-visible search, newest-first, "..." menu

**Files:**
- Modify: `packages/web/src/app/pages/playlists/playlists.component.ts`

### 8a: Playlists list newest-first default

- [ ] **Step 1: Find the grid `ListControls` connection**

Around line 226 in `playlists.component.ts`, find:
```typescript
defaultSort: 'name',
```

Change to:
```typescript
defaultSort: 'created',
defaultDirection: 'desc',
```

### 8b: Always-visible search

- [ ] **Step 1: Ensure `ListToolbarComponent` is in imports**

It should already be there. Confirm.

- [ ] **Step 2: In both the playlist grid and detail views, ensure the toolbar is rendered unconditionally** (not behind a toggle button).

If there's a condition like `@if (isToolbarVisible())` wrapping the search bar in either view, remove it so the toolbar always renders.

### 8c: Rename modal

- [ ] **Step 1: Add `ConfirmDialogComponent` and `showRenameModal` signal**

```typescript
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
```

Add to imports array.

Add signals (note: `editingName` and `nameDraft` already exist around line 213):

```typescript
  showRenameModal = signal(false);
```

The existing `startRename()` and `saveRename()` methods can remain. Just add:

```typescript
  openRenameModal() {
    this.nameDraft = this.selected()?.name ?? '';
    this.showRenameModal.set(true);
  }

  closeRenameModal() {
    this.showRenameModal.set(false);
  }
```

- [ ] **Step 2: Add rename modal to template**

```html
@if (showRenameModal()) {
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
       (click)="closeRenameModal()">
    <div class="bg-theme-surface border border-theme rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl"
         (click)="$event.stopPropagation()">
      <h3 class="text-theme-primary font-medium mb-4">Rename playlist</h3>
      <input
        class="w-full bg-theme-surface-2 text-theme-primary text-sm px-3 py-2 rounded-lg outline-none border border-theme focus:border-blue-500/50 mb-4"
        [(ngModel)]="nameDraft"
        (keydown.enter)="saveRename(); closeRenameModal()"
        (keydown.escape)="closeRenameModal()"
        autofocus
      />
      <div class="flex gap-3 justify-end">
        <button
          class="px-4 py-2 text-sm text-theme-secondary hover:text-theme-primary rounded-lg transition-colors"
          (click)="closeRenameModal()">
          Cancel
        </button>
        <button
          class="px-4 py-2 text-sm bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 rounded-lg transition-colors"
          (click)="saveRename(); closeRenameModal()">
          Save
        </button>
      </div>
    </div>
  </div>
}
```

- [ ] **Step 3: Add rename button to playlist detail header**

Find the playlist detail header in the template and add a rename (pencil) button:

```html
<button
  class="flex items-center gap-1.5 px-3 py-1.5 text-sm text-theme-secondary hover:text-theme-primary rounded-lg hover:bg-theme-hover transition-colors"
  (click)="openRenameModal()">
  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
  </svg>
  Rename
</button>
```

### 8d: "..." menu on playlist track rows

- [ ] **Step 1: Add `TrackAction` import**

```typescript
import { TrackRowComponent, TrackAction } from '../../components/track-row/track-row.component';
```

- [ ] **Step 2: Add confirm signals**

```typescript
  confirmMessage = signal('');
  confirmCallback = signal<(() => void) | null>(null);
  showConfirm = computed(() => this.confirmCallback() !== null);

  private askConfirm(message: string, cb: () => void) {
    this.confirmMessage.set(message);
    this.confirmCallback.set(cb);
  }

  onConfirm() {
    const cb = this.confirmCallback();
    this.confirmCallback.set(null);
    cb?.();
  }

  onCancelConfirm() {
    this.confirmCallback.set(null);
  }
```

- [ ] **Step 3: Add `playlistTrackActions()` method**

```typescript
  playlistTrackActions(item: DetailItem): TrackAction[] {
    return [
      {
        label: 'Add to playlist',
        action: () => {
          // TODO: wire PlaylistAutocompleteComponent
        },
      },
      {
        label: 'Go to artist',
        action: () => this.router.navigate(['/library', 'artists'], { queryParams: { name: item.artist } }),
      },
      {
        label: 'Go to album',
        action: () => this.router.navigate(['/library'], { queryParams: { album: item.album } }),
      },
      {
        label: 'Remove from playlist',
        destructive: true,
        action: () => this.askConfirm(`Remove "${item.title}" from playlist?`, () => this.removeSong(item._originalIndex)),
      },
      {
        label: 'Details',
        action: () => alert(`${item.title}\n${item.artist} · ${item.album}`),
      },
    ];
  }
```

Inject `Router`:
```typescript
import { Router } from '@angular/router';
private router = inject(Router);
```

- [ ] **Step 4: Update existing `app-track-row` in detail view to pass actions**

```html
<app-track-row
  [track]="{ id: item.id, title: item.title, artist: item.artist, album: item.album, coverArt: item.coverArt, duration: item.duration }"
  [indexLabel]="i + 1"
  [duration]="item.duration"
  [actions]="playlistTrackActions(item)"
  (play)="handlePlay(item)"
/>
```

- [ ] **Step 5: Add confirm dialog to template**

```html
@if (showConfirm()) {
  <app-confirm-dialog
    [message]="confirmMessage()"
    confirmLabel="Remove"
    (confirm)="onConfirm()"
    (cancel)="onCancelConfirm()"
  />
}
```

- [ ] **Step 6: Add `FormsModule` to imports if not already present** (needed for `[(ngModel)]` in rename modal)

- [ ] **Step 7: Run typecheck**

```bash
bun run typecheck
```

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/app/pages/playlists/playlists.component.ts
git commit -m "feat: playlists — rename modal, newest-first, always-visible search, track context menu"
```

---

## Task 9: Final typecheck + lint pass

- [ ] **Step 1: Run full typecheck**

```bash
bun run typecheck
```

Expected: zero errors.

- [ ] **Step 2: Run lint**

```bash
bun run lint
```

Fix any errors. Warnings about unused variables from removed code are safe to ignore if the variable was intentionally removed.

- [ ] **Step 3: Build the web package to verify no compile errors**

```bash
cd packages/web && npx ng build --configuration development 2>&1 | tail -20
```

Expected: Build succeeds with no errors.

- [ ] **Step 4: Final commit if lint fixes were needed**

```bash
git add -p
git commit -m "fix: lint and typecheck cleanup after Phase 2 UI overhaul"
```

---

## Self-Review Notes

- **`getSongsByGenre` frontend method** hits `/api/library/genres/songs` — Task 3b adds the backend route if absent.
- **`PlaylistAutocompleteComponent` artist hint** is left empty because fetching full playlist entries for every playlist on load would be expensive. This is called out inline.
- **`showSongDetails` in Downloads** uses `alert()` as a placeholder — explicitly noted as Phase 3 work.
- **"Go to album" in playlists** uses `item.album` (the album name string) as a query param but `LibraryComponent` uses album ID to open the detail. The `DetailItem` type in Playlists needs to carry `albumId` for this to work correctly. When implementing Task 8d, check whether `DetailItem` has `albumId` — if not, add it when mapping playlist entries.
- **`nameDraft`** in Playlists is typed as a class property string (not a signal) — the `[(ngModel)]` binding uses it directly. Confirm this in the existing code before implementing Task 8c.

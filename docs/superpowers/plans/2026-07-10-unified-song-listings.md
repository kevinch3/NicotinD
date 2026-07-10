# Unified Song Listings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every song listing draw its row menu from one `SongMenuService` and its multiselect from one `createSelection()`, guaranteeing a consistent common action set and killing per-page copy-paste.

**Architecture:** A root `SongMenuService.build(song, ctx)` is the single source of truth for a song's `⋯` menu. The `TrackRowComponent` stays presentational. Global `TrackInfoService`/`ConfirmService` + hosts (mounted once in `layout.component.html`) back the "Song info" and "Remove" actions. Removal collapses to `api.deleteSongs → transferService.addDeletedIds`, with every listing filtering rows through `deletedSongIds()`. Downloads migrates onto `createSelection()`.

**Tech Stack:** Angular v22 (standalone, signals), vitest (JIT) unit tests, Playwright e2e, Tailwind.

## Global Constraints

- **Node ≥ 22.22.3** for `ng build`/`ng test` (host default nvm node 22.22.0 fails — `nvm use 22.22.3` first). [from project memory]
- New shared types re-exported through `packages/web/src/types/core.ts` only if they come from `@nicotind/core`; local web types live in web. [from project memory]
- vitest runs in **JIT** — do **not** drive `input()` signals in tests. Services (plain classes with `inject()`) are tested via `TestBed` with mocked providers; this plan's units are all services + pure logic, sidestepping the input() limitation. [from project memory]
- **No Claude attribution** in commits. [from project memory]
- Every change tested + tests run in CI + docs updated in the same change (project Quality Gates).
- Run `bun run format` **only** on touched files if needed — it dirties the whole repo otherwise. Prefer targeted prettier. [from project memory]
- Commit messages: Conventional Commits (`feat`/`fix`/`refactor`/`docs`/`test`).
- Work on branch `feat/unified-song-listings` (already created; spec committed there).

---

### Task 1: Root `ConfirmService` + confirm dialog

**Files:**
- Create: `packages/web/src/app/services/confirm.service.ts`
- Create: `packages/web/src/app/components/confirm-dialog/confirm-dialog.component.ts`
- Modify: `packages/web/src/app/components/layout/layout.component.ts` (imports array)
- Modify: `packages/web/src/app/components/layout/layout.component.html` (mount)
- Test: `packages/web/src/app/services/confirm.service.spec.ts`

**Interfaces:**
- Produces: `ConfirmService` with `readonly request = signal<{ message: string } | null>(null)`, `ask(message: string): Promise<boolean>`, `resolve(ok: boolean): void`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/app/services/confirm.service.spec.ts
import { TestBed } from '@angular/core/testing';
import { ConfirmService } from './confirm.service';

describe('ConfirmService', () => {
  let svc: ConfirmService;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [ConfirmService] });
    svc = TestBed.inject(ConfirmService);
  });

  it('ask() opens a request and resolves true on confirm', async () => {
    const p = svc.ask('Delete this?');
    expect(svc.request()?.message).toBe('Delete this?');
    svc.resolve(true);
    await expect(p).resolves.toBe(true);
    expect(svc.request()).toBeNull();
  });

  it('ask() resolves false on cancel', async () => {
    const p = svc.ask('Delete this?');
    svc.resolve(false);
    await expect(p).resolves.toBe(false);
    expect(svc.request()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/app/services/confirm.service.spec.ts`
Expected: FAIL — cannot find module `./confirm.service`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/web/src/app/services/confirm.service.ts
import { Injectable, signal } from '@angular/core';

/**
 * Global confirm dialog. A single modal (see ConfirmDialogComponent, mounted in
 * the layout) renders whatever `request()` holds; callers await `ask()`. Root
 * so any service/page shares one modal instead of hand-rolling askConfirm.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly request = signal<{ message: string } | null>(null);
  private pending: ((ok: boolean) => void) | null = null;

  ask(message: string): Promise<boolean> {
    // A prior open request resolves false before we replace it.
    this.pending?.(false);
    this.request.set({ message });
    return new Promise<boolean>((res) => (this.pending = res));
  }

  resolve(ok: boolean): void {
    this.request.set(null);
    const p = this.pending;
    this.pending = null;
    p?.(ok);
  }
}
```

```ts
// packages/web/src/app/components/confirm-dialog/confirm-dialog.component.ts
import { Component, inject } from '@angular/core';
import { ConfirmService } from '../../services/confirm.service';

@Component({
  selector: 'app-confirm-dialog',
  template: `
    @if (confirm.request(); as req) {
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
           data-testid="confirm-dialog" (click)="confirm.resolve(false)">
        <div class="bg-theme-surface border border-theme rounded-xl p-6 max-w-sm w-full shadow-2xl"
             (click)="$event.stopPropagation()">
          <p class="text-sm text-theme-primary mb-6">{{ req.message }}</p>
          <div class="flex gap-3 justify-end">
            <button type="button" data-testid="confirm-cancel"
              class="px-4 py-2 rounded-lg text-theme-secondary hover:bg-theme-hover transition"
              (click)="confirm.resolve(false)">Cancel</button>
            <button type="button" data-testid="confirm-ok"
              class="px-4 py-2 rounded-lg status-error hover:opacity-80 transition"
              (click)="confirm.resolve(true)">Confirm</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ConfirmDialogComponent {
  readonly confirm = inject(ConfirmService);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/app/services/confirm.service.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Mount the dialog in the layout**

In `layout.component.ts`: add `import { ConfirmDialogComponent } from '../confirm-dialog/confirm-dialog.component';` and add `ConfirmDialogComponent` to the component `imports` array.

In `layout.component.html`, directly after the `<app-add-to-playlist />` line, add:

```html
      <!-- Global confirm dialog (renders only when a request is open) -->
      <app-confirm-dialog />
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd packages/web && npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors.

```bash
git add packages/web/src/app/services/confirm.service.ts packages/web/src/app/services/confirm.service.spec.ts packages/web/src/app/components/confirm-dialog/ packages/web/src/app/components/layout/layout.component.ts packages/web/src/app/components/layout/layout.component.html
git commit -m "feat(web): global ConfirmService + confirm dialog"
```

---

### Task 2: Global `TrackInfoService` + `TrackInfoHost`

**Files:**
- Create: `packages/web/src/app/services/track-info.service.ts`
- Create: `packages/web/src/app/components/track-info-host/track-info-host.component.ts`
- Modify: `packages/web/src/app/components/layout/layout.component.ts` + `.html` (mount)
- Modify: `packages/web/src/app/components/now-playing/now-playing.component.ts` + `.html` (delegate to service)
- Test: `packages/web/src/app/services/track-info.service.spec.ts`

**Interfaces:**
- Consumes: `TrackInfoSheetComponent` (existing) inputs `songId`, `displayTitle/Artist/Album/CoverArt`, `(close)`.
- Produces: `TrackInfoService` with `readonly target = signal<TrackInfoTarget | null>(null)`, `open(t: TrackInfoTarget): void`, `close(): void`, where `interface TrackInfoTarget { songId: string; title?: string; artist?: string; album?: string; coverArt?: string | null }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/app/services/track-info.service.spec.ts
import { TestBed } from '@angular/core/testing';
import { TrackInfoService } from './track-info.service';

describe('TrackInfoService', () => {
  let svc: TrackInfoService;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TrackInfoService] });
    svc = TestBed.inject(TrackInfoService);
  });

  it('open() stores the target; close() clears it', () => {
    svc.open({ songId: 's1', title: 'Toxic' });
    expect(svc.target()?.songId).toBe('s1');
    expect(svc.target()?.title).toBe('Toxic');
    svc.close();
    expect(svc.target()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/app/services/track-info.service.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/web/src/app/services/track-info.service.ts
import { Injectable, signal } from '@angular/core';

export interface TrackInfoTarget {
  songId: string;
  title?: string;
  artist?: string;
  album?: string;
  coverArt?: string | null;
}

/**
 * Opens the track-info sheet from anywhere. A single TrackInfoHost (mounted in
 * the layout) renders `target()`; the now-playing view and every song-row menu
 * call `open()`. Root so the sheet is mounted once, not per-consumer.
 */
@Injectable({ providedIn: 'root' })
export class TrackInfoService {
  readonly target = signal<TrackInfoTarget | null>(null);
  open(t: TrackInfoTarget): void {
    this.target.set(t);
  }
  close(): void {
    this.target.set(null);
  }
}
```

```ts
// packages/web/src/app/components/track-info-host/track-info-host.component.ts
import { Component, inject } from '@angular/core';
import { TrackInfoService } from '../../services/track-info.service';
import { TrackInfoSheetComponent } from '../track-info-sheet/track-info-sheet.component';

@Component({
  selector: 'app-track-info-host',
  imports: [TrackInfoSheetComponent],
  template: `
    @if (info.target(); as t) {
      <app-track-info-sheet
        [songId]="t.songId"
        [displayTitle]="t.title ?? ''"
        [displayArtist]="t.artist ?? ''"
        [displayAlbum]="t.album ?? ''"
        [displayCoverArt]="t.coverArt ?? null"
        (close)="info.close()"
      />
    }
  `,
})
export class TrackInfoHostComponent {
  readonly info = inject(TrackInfoService);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/app/services/track-info.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Mount host in layout**

In `layout.component.ts`: add `import { TrackInfoHostComponent } from '../track-info-host/track-info-host.component';` and add `TrackInfoHostComponent` to `imports`.

In `layout.component.html`, after the `<app-confirm-dialog />` line from Task 1, add:

```html
      <!-- Global track-info sheet host (renders only when a target is open) -->
      <app-track-info-host />
```

- [ ] **Step 6: Delegate now-playing to the service**

In `now-playing.component.ts`: inject `readonly trackInfo = inject(TrackInfoService);` (add the import). Replace the body of `onOpenTrackInfo`:

```ts
  onOpenTrackInfo(songId: string): void {
    this.contextMenu.set(null);
    const t = this.player.currentTrack();
    this.trackInfo.open({
      songId,
      title: t?.title,
      artist: t?.artist,
      album: t?.album,
      coverArt: t?.coverArt ?? null,
    });
  }
```

Remove the now-dead `trackInfoSongId` signal declaration and, in `now-playing.component.html`, delete the entire `@if (trackInfoSongId(); as infoId) { <app-track-info-sheet ... /> }` block (the global host renders it now). Remove the `TrackInfoSheetComponent` import from `now-playing.component.ts` if no longer referenced.

- [ ] **Step 7: Typecheck + commit**

Run: `cd packages/web && npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors.

```bash
git add packages/web/src/app/services/track-info.service.ts packages/web/src/app/services/track-info.service.spec.ts packages/web/src/app/components/track-info-host/ packages/web/src/app/components/layout/ packages/web/src/app/components/now-playing/
git commit -m "feat(web): global TrackInfoService + host, delegate now-playing to it"
```

---

### Task 3: PlayerService — `albumId` on Track, `queueNext`, `startRadio`

**Files:**
- Modify: `packages/web/src/app/services/player.service.ts` (Track interface + 2 methods)
- Test: `packages/web/src/app/services/player.service.spec.ts` (add cases; create file if absent)

**Interfaces:**
- Produces on `PlayerService`: `queueNext(track: Track): void` (insert at head of `queue`), `startRadio(track: Track): void` (play track + turn radio on). `Track` gains `albumId?: string`.

- [ ] **Step 1: Write the failing test**

Add to `player.service.spec.ts` (create with the standard TestBed harness if the file does not exist):

```ts
import { TestBed } from '@angular/core/testing';
import { PlayerService, type Track } from './player.service';

const t = (id: string): Track => ({ id, title: id, artist: 'a' });

describe('PlayerService queueNext / startRadio', () => {
  let player: PlayerService;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [PlayerService] });
    player = TestBed.inject(PlayerService);
  });

  it('queueNext inserts at the front of the queue', () => {
    player.addToQueue(t('b'));
    player.queueNext(t('a'));
    expect(player.queue().map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('startRadio makes the track current and turns radio on', () => {
    player.startRadio(t('seed'));
    expect(player.currentTrack()?.id).toBe('seed');
    expect(player.isPlaying()).toBe(true);
    expect(player.radio()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/app/services/player.service.spec.ts`
Expected: FAIL — `queueNext`/`startRadio` not a function.

- [ ] **Step 3: Write minimal implementation**

In `player.service.ts`, add `albumId?: string;` to the `Track` interface (next to `album?: string;`).

Add these methods right after `addToQueue`:

```ts
  /** Insert a track to play immediately after the current one. */
  queueNext(track: Track): void {
    this.queue.update((q) => [track, ...q]);
  }

  /** Start radio seeded on a specific song: play it, then enable radio (which
   * replenishes from the current track). */
  startRadio(track: Track): void {
    this.play(track);
    if (!this.radio()) this.toggleRadio();
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/app/services/player.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/services/player.service.ts packages/web/src/app/services/player.service.spec.ts
git commit -m "feat(web): Track.albumId + PlayerService.queueNext/startRadio"
```

---

### Task 4: `albumId` on `BaseSong` + `toTrack`

**Files:**
- Modify: `packages/web/src/app/lib/track-utils.ts` (`BaseSong`, `toTrack`)
- Test: `packages/web/src/app/lib/track-utils.spec.ts` (create if absent)

**Interfaces:**
- Consumes: `Track.albumId` (Task 3).
- Produces: `BaseSong` gains `albumId?: string`; `toTrack` maps it.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/app/lib/track-utils.spec.ts (add or create)
import { toTrack } from './track-utils';

describe('toTrack', () => {
  it('carries albumId through', () => {
    const track = toTrack({ id: 's1', title: 'T', artist: 'A', albumId: 'alb1' });
    expect(track.albumId).toBe('alb1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/app/lib/track-utils.spec.ts`
Expected: FAIL — `albumId` not on `BaseSong` (TS error) / undefined at runtime.

- [ ] **Step 3: Write minimal implementation**

In `track-utils.ts`, add `albumId?: string;` to `BaseSong` (next to `album?: string;`) and add `albumId: song.albumId,` to the object returned by `toTrack`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/app/lib/track-utils.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/lib/track-utils.ts packages/web/src/app/lib/track-utils.spec.ts
git commit -m "feat(web): thread albumId through BaseSong/toTrack"
```

---

### Task 5: `SongMenuService` — the single source of truth

**Files:**
- Create: `packages/web/src/app/services/song-menu.service.ts`
- Create: `packages/web/src/app/services/song-menu.service.spec.ts`
- Create: `docs/song-actions.md`
- Modify: `CLAUDE.md` (one index line)

**Interfaces:**
- Consumes: `PlayerService` (`addToQueue`, `queueNext`, `startRadio`), `PlaylistService.openPicker`, `PreserveService` (via `offlineTrackAction`), `Router`, `AuthService.role`, `LibraryApiService.deleteSongs`, `TransferService.addDeletedIds`, `TrackInfoService.open`, `ConfirmService.ask`, `resolveArtistRoute`/`resolveAlbumRoute`, `toTrack`/`offlineTrackAction`/`addToPlaylistAction`, `TrackAction` type, `BaseSong`.
- Produces: `SongMenuService.build(song: BaseSong, ctx?: SongContext): TrackAction[]` and `interface SongContext { hideGoToArtist?: boolean; hideGoToAlbum?: boolean; removable?: boolean; onRemoveFromPlaylist?: () => void; extraActions?: TrackAction[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/web/src/app/services/song-menu.service.spec.ts
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { SongMenuService } from './song-menu.service';
import { PlayerService } from './player.service';
import { PlaylistService } from './playlist.service';
import { PreserveService } from './preserve.service';
import { AuthService } from './auth.service';
import { LibraryApiService } from './api/library-api.service';
import { TransferService } from './transfer.service';
import { TrackInfoService } from './track-info.service';
import { ConfirmService } from './confirm.service';
import type { BaseSong } from '../lib/track-utils';

const song = (over: Partial<BaseSong> = {}): BaseSong => ({
  id: 's1', title: 'Toxic', artist: 'Britney', ...over,
});

function setup(role: 'admin' | 'user' = 'user') {
  const router = { navigate: vi.fn() };
  const auth = { role: () => role };
  TestBed.configureTestingModule({
    providers: [
      SongMenuService,
      PlayerService,
      { provide: Router, useValue: router },
      { provide: AuthService, useValue: auth },
      { provide: PlaylistService, useValue: { openPicker: vi.fn() } },
      { provide: PreserveService, useValue: { isPreserved: () => false, isPreserving: () => false } },
      { provide: LibraryApiService, useValue: { deleteSongs: vi.fn(() => ({ subscribe: vi.fn() })) } },
      { provide: TransferService, useValue: { addDeletedIds: vi.fn() } },
      { provide: TrackInfoService, useValue: { open: vi.fn() } },
      { provide: ConfirmService, useValue: { ask: vi.fn(async () => true) } },
    ],
  });
  return { svc: TestBed.inject(SongMenuService), router, auth };
}

const labels = (song: BaseSong, svc: SongMenuService, ctx = {}) =>
  svc.build(song, ctx).map((a) => a.label);

describe('SongMenuService.build', () => {
  it('emits the 8 common actions in order when data allows', () => {
    const { svc } = setup();
    expect(labels(song({ artistId: 'ar1', albumId: 'al1' }), svc)).toEqual([
      'Add to queue', 'Play next', 'Start radio', 'Go to artist',
      'Go to album', 'Add to playlist', 'Save offline', 'Song info',
    ]);
  });

  it('hides Go to album without albumId', () => {
    const { svc } = setup();
    expect(labels(song({ artistId: 'ar1' }), svc)).not.toContain('Go to album');
  });

  it('hides Go to artist without artistId', () => {
    const { svc } = setup();
    expect(labels(song({ albumId: 'al1' }), svc)).not.toContain('Go to artist');
  });

  it('respects hideGoToArtist / hideGoToAlbum', () => {
    const { svc } = setup();
    const out = labels(song({ artistId: 'ar1', albumId: 'al1' }), svc, {
      hideGoToArtist: true, hideGoToAlbum: true,
    });
    expect(out).not.toContain('Go to artist');
    expect(out).not.toContain('Go to album');
  });

  it('adds Remove from library only for admin + removable', () => {
    expect(labels(song(), setup('user').svc, { removable: true })).not.toContain('Remove from library');
    expect(labels(song(), setup('admin').svc, { removable: true })).toContain('Remove from library');
  });

  it('appends onRemoveFromPlaylist and extraActions last', () => {
    const { svc } = setup();
    const out = labels(song(), svc, {
      onRemoveFromPlaylist: () => {},
      extraActions: [{ label: 'X', action: () => {} }],
    });
    expect(out.slice(-2)).toEqual(['Remove from playlist', 'X']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && npx vitest run src/app/services/song-menu.service.spec.ts`
Expected: FAIL — cannot find module `./song-menu.service`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/web/src/app/services/song-menu.service.ts
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { PlayerService } from './player.service';
import { PlaylistService } from './playlist.service';
import { PreserveService } from './preserve.service';
import { AuthService } from './auth.service';
import { LibraryApiService } from './api/library-api.service';
import { TransferService } from './transfer.service';
import { TrackInfoService } from './track-info.service';
import { ConfirmService } from './confirm.service';
import { resolveArtistRoute, resolveAlbumRoute } from '../lib/route-utils';
import { toTrack, offlineTrackAction, addToPlaylistAction, type BaseSong } from '../lib/track-utils';
import type { TrackAction } from '../components/track-row/track-row.component';

export interface SongContext {
  /** Suppress "Go to artist" (e.g. on the artist page — redundant there). */
  hideGoToArtist?: boolean;
  /** Suppress "Go to album" (e.g. on the album page). */
  hideGoToAlbum?: boolean;
  /** Offer admin-gated "Remove from library". */
  removable?: boolean;
  /** Offer "Remove from playlist" wired to this callback. */
  onRemoveFromPlaylist?: () => void;
  /** Page-unique actions appended last. */
  extraActions?: TrackAction[];
}

/**
 * Single source of truth for a song's `⋯` menu. Every listing calls `build()`
 * so the common action set is guaranteed everywhere and contextual actions are
 * declared, not re-coded. See docs/song-actions.md.
 */
@Injectable({ providedIn: 'root' })
export class SongMenuService {
  private readonly player = inject(PlayerService);
  private readonly playlists = inject(PlaylistService);
  private readonly preserve = inject(PreserveService);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly api = inject(LibraryApiService);
  private readonly transfers = inject(TransferService);
  private readonly trackInfo = inject(TrackInfoService);
  private readonly confirm = inject(ConfirmService);

  build(song: BaseSong, ctx: SongContext = {}): TrackAction[] {
    const track = toTrack(song);
    const actions: TrackAction[] = [
      { label: 'Add to queue', action: () => this.player.addToQueue(track) },
      { label: 'Play next', action: () => this.player.queueNext(track) },
      { label: 'Start radio', action: () => this.player.startRadio(track) },
    ];

    if (song.artistId && !ctx.hideGoToArtist) {
      actions.push({
        label: 'Go to artist',
        action: () => void this.router.navigate(resolveArtistRoute(song.artistId)),
      });
    }
    if (song.albumId && !ctx.hideGoToAlbum) {
      actions.push({
        label: 'Go to album',
        action: () => void this.router.navigate(resolveAlbumRoute(song.albumId)),
      });
    }

    actions.push(addToPlaylistAction(this.playlists, song.id));
    actions.push(offlineTrackAction(this.preserve, track));
    actions.push({
      label: 'Song info',
      action: () =>
        this.trackInfo.open({
          songId: song.id,
          title: song.title,
          artist: song.artist,
          album: song.album,
          coverArt: song.coverArt ?? null,
        }),
    });

    if (ctx.removable && this.auth.role() === 'admin') {
      actions.push({
        label: 'Remove from library',
        destructive: true,
        action: () => void this.removeFromLibrary(song.id, song.title),
      });
    }
    if (ctx.onRemoveFromPlaylist) {
      actions.push({
        label: 'Remove from playlist',
        destructive: true,
        action: ctx.onRemoveFromPlaylist,
      });
    }
    if (ctx.extraActions?.length) actions.push(...ctx.extraActions);

    return actions;
  }

  /** Confirm → delete → mark deleted. Listings filter through
   * transferService.deletedSongIds(), so no per-page prune is needed. */
  private async removeFromLibrary(id: string, title: string): Promise<void> {
    if (!(await this.confirm.ask(`Remove "${title}" from library?`))) return;
    await firstValueFrom(this.api.deleteSongs([id]));
    this.transfers.addDeletedIds([id]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && npx vitest run src/app/services/song-menu.service.spec.ts`
Expected: PASS (6 tests). If ordering differs, align the `build()` push order to the expected array in the test.

- [ ] **Step 5: Write docs + index line**

Create `docs/song-actions.md`:

```markdown
# Unified song listings

Every song listing renders one `TrackRowComponent` and draws its `⋯` menu from
one root `SongMenuService.build(song, ctx)` — the single source of truth for a
song's actions. This prevents the per-page menu drift that previously left
"Go to album", "Start radio", "Add to queue", "Play next" and "Song info"
missing everywhere and "Go to artist" on only some pages.

## Common actions (always present when the data supports them)

Order: Add to queue → Play next → Start radio → Go to artist* → Go to album* →
Add to playlist → Save offline → Song info.
(*artist/album links appear only when the song carries `artistId`/`albumId` and
the context doesn't hide them.)

- **Play** is not a menu item — the row title/play button already plays.
- **Start radio** = `PlayerService.startRadio(track)` (play the seed + enable radio).
- **Add to queue** appends; **Play next** = `PlayerService.queueNext(track)` (insert after current).
- **Song info** opens the global track-info sheet via `TrackInfoService.open()`
  (sheet mounted once in the layout as `TrackInfoHost`).

## Contextual actions (`SongContext`)

- `hideGoToArtist` / `hideGoToAlbum` — suppress the redundant link on the
  artist / album page.
- `removable` — admin-only **Remove from library**: `ConfirmService.ask` →
  `api.deleteSongs` → `transferService.addDeletedIds`. **No per-page prune** —
  every listing filters rendered rows through `transferService.deletedSongIds()`.
- `onRemoveFromPlaylist` — **Remove from playlist** (playlist page).
- `extraActions` — page-unique items, appended last.

## Selection

Multi-select is one `createSelection()` per list (see `lib/selection.ts`) +
`SelectionBarComponent`. The bar's bulk set mirrors the row's common actions
(Play, Queue, Add to playlist, Save offline, Download, Delete via capability
flags). Downloads uses `createSelection()` too (one instance per list it shows).
```

In `CLAUDE.md`, under "Key Design Patterns", add one line:

```markdown
- **Unified song listings**: one `TrackRowComponent` + one root `SongMenuService.build(song, ctx)` build every song's `⋯` menu (common actions guaranteed, contextual via `SongContext`); Remove routes through `ConfirmService`→`deleteSongs`→`deletedSongIds()` (no per-page prune); "Song info" opens a global `TrackInfoService` host; multiselect is one `createSelection()` + `SelectionBarComponent` everywhere (incl. Downloads). → [docs/song-actions.md](docs/song-actions.md)
```

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/app/services/song-menu.service.ts packages/web/src/app/services/song-menu.service.spec.ts docs/song-actions.md CLAUDE.md
git commit -m "feat(web): SongMenuService single source of truth for song menus"
```

---

### Task 6: Route the four library pages through `SongMenuService`

**Files:**
- Modify: `packages/web/src/app/pages/library/album-detail.component.ts` + `.html`
- Modify: `packages/web/src/app/pages/library/artist-detail.component.ts` + `.html`
- Modify: `packages/web/src/app/pages/library/genre-detail.component.ts` + `.html`
- Modify: `packages/web/src/app/pages/library/playlist-detail.component.ts` + `.html`
- Test: extend each page's existing `*.spec.ts` with a filter-through-deletedSongIds assertion (see Step 5).

**Interfaces:**
- Consumes: `SongMenuService.build`, `SongContext`, `transferService.deletedSongIds()`.

- [ ] **Step 1: album-detail — swap the action builder**

In `album-detail.component.ts`: inject `readonly songMenu = inject(SongMenuService);` (add import). Delete the `albumTrackActions(...)` method entirely. In `album-detail.component.html` replace `[actions]="albumTrackActions(song)"` with:

```html
          [actions]="songMenu.build(toSong(song), { hideGoToAlbum: true, removable: true })"
```

Add a small adapter on the component to shape the album's track into `BaseSong` (albums already know their own id):

```ts
  toSong(s: { id: string; title: string; artist: string; artistId?: string; coverArt?: string; duration?: number; bitRate?: number }) {
    return { ...s, albumId: this.selectedAlbum()?.id, album: this.selectedAlbum()?.name };
  }
```

Confirm the album list already filters through `deletedSongIds()` (it does at
`album-detail.component.ts:71`). Delete the now-dead local prune in the old
delete closure and the `askConfirm`/`deleteError` plumbing **only if** nothing
else uses them (bulk delete may still — keep bulk as-is for now; bulk stays on
the selection bar path).

- [ ] **Step 2: artist-detail — swap the builder + add deletedSongIds filter**

In `artist-detail.component.ts`: inject `SongMenuService`. Delete `artistTrackActions(...)`. In the template replace `[actions]="artistTrackActions(song)"` with:

```html
          [actions]="songMenu.build(song, { hideGoToArtist: true, removable: true })"
```

Artist songs already satisfy `BaseSong` (`Song` has id/title/artist/artistId/album/coverArt/duration). Ensure the rendered song list filters deleted ids: wrap the songs source in a computed that excludes them, e.g. where `songs()` is consumed by the template, add:

```ts
  readonly visibleSongs = computed(() => {
    const deleted = this.transferService.deletedSongIds();
    return this.songs().filter((s) => !deleted.has(s.id));
  });
```

Point the template's `@for` at `visibleSongs()` instead of `songs()`. Delete the old per-row delete closure's manual `pruneSongs([song.id])` path (the filter now handles disappearance); keep `pruneSongs` only if bulk selection still calls it.

- [ ] **Step 3: genre-detail — swap the builder**

In `genre-detail.component.ts`: inject `SongMenuService`, delete `genreTrackActions(...)`. Template: replace with `[actions]="songMenu.build(song, { removable: true })"`. Genre list already filters `deletedSongIds()` at line 60. Remove the dead per-row prune closure.

- [ ] **Step 4: playlist-detail — swap the builder + add filter**

In `playlist-detail.component.ts`: inject `SongMenuService`, delete `songActions(...)`. Template: replace with:

```html
          [actions]="songMenu.build(song, { onRemoveFromPlaylist: () => removeFromPlaylist(song.id) })"
```

If a `removeFromPlaylist(id)` method doesn't exist, add one that calls the
existing playlist-remove path (mirror whatever the row `(remove)` output is
already wired to). Add a `visibleSongs` computed filtering `deletedSongIds()`
and point the `@for` at it (playlist songs are library songs and can be deleted
elsewhere).

- [ ] **Step 5: Write/extend a filter test for one page as the regression anchor**

Add to `album-detail.component.spec.ts` (or the page's existing spec) a test asserting a song whose id is in `deletedSongIds()` is excluded from the rendered list. Use the existing spec's component-construction harness (DI-free per project convention — see `track-row.component.spec.ts` pattern). Example shape:

```ts
it('drops rows whose id is marked deleted', () => {
  // arrange: component with one album track 's1', transferService.deletedSongIds -> Set(['s1'])
  // assert: the filtered list used by the template excludes 's1'
});
```

If the page has no spec harness yet, add the minimal one following
`route-utils.spec.ts` / `selection` DI-free conventions; do not attempt to drive
`input()` signals (JIT limitation) — assert the component's computed/list
method directly.

- [ ] **Step 6: Typecheck, run web unit tests, commit**

Run: `cd packages/web && npx tsc --noEmit -p tsconfig.app.json && npx vitest run`
Expected: no TS errors; all specs pass.

```bash
git add packages/web/src/app/pages/library/
git commit -m "refactor(web): route library song menus through SongMenuService + deletedSongIds filter"
```

---

### Task 7: SelectionBar `canPreserve` + migrate Downloads onto `createSelection()`

**Files:**
- Modify: `packages/web/src/app/components/selection-bar/selection-bar.component.ts` + `.html`
- Modify: `packages/web/src/app/pages/downloads/downloads.component.ts` + `.html`
- Test: `packages/web/src/app/components/selection-bar/selection-bar.component.spec.ts` (create if absent) for the new output; extend downloads spec for selection.

**Interfaces:**
- Produces: `SelectionBarComponent` gains `readonly canPreserve = input(false)` and `readonly preserve = output<void>()`.
- Consumes: `createSelection()` (existing), `SongMenuService`, `transferService.deletedSongIds()`.

- [ ] **Step 1: Add canPreserve to the selection bar (test first)**

```ts
// selection-bar.component.spec.ts
import { TestBed } from '@angular/core/testing';
import { SelectionBarComponent } from './selection-bar.component';

it('exposes a preserve output guarded by canPreserve', () => {
  // DI-free: instantiate and assert the output exists; template gating covered by e2e
  const fixture = TestBed.createComponent(SelectionBarComponent);
  expect(fixture.componentInstance.preserve).toBeDefined();
  expect(fixture.componentInstance.canPreserve).toBeDefined();
});
```

Run to fail: `cd packages/web && npx vitest run src/app/components/selection-bar/selection-bar.component.spec.ts` → FAIL.

Add to `selection-bar.component.ts`: `readonly canPreserve = input(false);` and `readonly preserve = output<void>();`.

In `selection-bar.component.html`, after the queue button block, add:

```html
    @if (canPreserve()) {
      <button type="button" (click)="preserve.emit()" [disabled]="count() === 0"
        data-testid="selection-preserve" aria-label="Save offline" title="Save offline"
        class="w-8 h-8 flex items-center justify-center rounded-lg bg-theme-surface text-theme-secondary hover:bg-theme-hover transition disabled:opacity-40 disabled:pointer-events-none">
        <app-icon name="download" [size]="16" />
      </button>
    }
```

Run to pass. (Note: the existing `canDownload`/`download` remains distinct — that's the network-download bulk action; `preserve` is save-offline.)

- [ ] **Step 2: Migrate Downloads selection — replace bespoke Set with createSelection()**

In `downloads.component.ts`: import `createSelection` and add `readonly selection = createSelection();`. Replace the recent-songs selection usages:
- `readonly selected = signal(new Set<string>())` → remove; use `this.selection`.
- `isSelected(id)` → `this.selection.isSelected(id)`.
- `toggleSelect(id, event)` → `this.selection.toggleRange(id, this.recentOrderedIds(), event.shiftKey)` (add a `recentOrderedIds` computed of the currently displayed ids).
- `selectAll` → `this.selection.selectAll(this.recentSongs().map((s) => s.id))`.
- `selectedArray()` → `[...this.selection.ids()]`.
- selection-active checks → `this.selection.active()`; enter/exit via `this.selection.enter()/exit()`.

Keep the **preserved-tracks** list on its own instance: `readonly offlineSelection = createSelection();` replacing `offlineSelected`.

Update `downloads.component.html`: bind the recent-songs rows' `[selectable]`/`[selected]`/`(selectedChange)` to `this.selection`, and render `<app-selection-bar>` with the appropriate capability flags (`[canDelete]="auth.role()==='admin'"`, `[canPlay]`, `[canQueue]`, `[canPreserve]`) wired to selection outputs. Replace the per-row `songActions(song)` with `songMenu.build(song, { removable: true })` (inject `SongMenuService`; delete the local `songActions`).

- [ ] **Step 3: Filter recent songs through deletedSongIds**

Add `readonly visibleRecent = computed(() => { const d = this.transferService.deletedSongIds(); return this.recentSongs().filter((s) => !d.has(s.id)); });` and point the recent-songs `@for` and `recentOrderedIds` at it. (Inject `TransferService` if not already.)

- [ ] **Step 4: Extend downloads spec**

Add a spec asserting the migrated selection: selecting two ids then `selectedArray()`/`selection.ids()` has size 2, and `visibleRecent` excludes a deleted id. Follow the page's existing DI-free spec harness.

- [ ] **Step 5: Typecheck, test, commit**

Run: `cd packages/web && npx tsc --noEmit -p tsconfig.app.json && npx vitest run`
Expected: green.

```bash
git add packages/web/src/app/components/selection-bar/ packages/web/src/app/pages/downloads/
git commit -m "refactor(web): unify Downloads selection on createSelection + SongMenuService; selection-bar canPreserve"
```

---

### Task 8: Route Search local-song menus through `SongMenuService`

**Files:**
- Modify: `packages/web/src/app/pages/search/search.component.ts` + `.html`

**Interfaces:**
- Consumes: `SongMenuService.build`.

- [ ] **Step 1: Swap the builder**

In `search.component.ts`: inject `SongMenuService`, delete `songActions(songId)` (currently returns only add-to-playlist). Confirm the local-library song objects rendered as `app-track-row` satisfy `BaseSong` (id/title/artist, plus `artistId`/`albumId` when present). In the template replace `[actions]="songActions(song.id)"` with:

```html
          [actions]="songMenu.build(song)"
```

(No `removable` — search is not an admin management surface; no `hide*` — links show when ids exist.) If the search song shape lacks `albumId`/`artistId`, that's fine — those actions self-hide.

- [ ] **Step 2: Typecheck + commit**

Run: `cd packages/web && npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors.

```bash
git add packages/web/src/app/pages/search/
git commit -m "refactor(web): route search song menu through SongMenuService"
```

---

### Task 9: e2e coverage + final verification

**Files:**
- Modify: `packages/web/src/app/components/track-row/track-row.component.html` (add `data-testid` to menu items)
- Create/Modify: `packages/e2e/tests/song-menu.spec.ts`

**Interfaces:**
- Consumes: the full stack from Tasks 1–8.

- [ ] **Step 1: Give menu items stable testids**

In `track-row.component.html`, on the menu `<button>` inside the `@for (action of actions())` loop, add `[attr.data-testid]="'track-action-' + action.label"` (or a slugified variant). This lets e2e target actions by label.

- [ ] **Step 2: Write the e2e flow**

Create `packages/e2e/tests/song-menu.spec.ts` following the existing e2e harness (boot real server + fixtures, log in). Assert, on an album detail page:
- Opening a row's `⋯` menu shows `Add to queue`, `Play next`, `Start radio`, `Go to artist`, `Add to playlist`, `Save offline`, `Song info`, and (album page) **no** `Go to album`.
- Clicking `Song info` opens the track-info sheet (`[data-testid]` already present on the sheet, or add one).
- As admin, `Remove from library` → confirm dialog (`data-testid="confirm-dialog"`) → `confirm-ok` → the row disappears.

Model the boot/login/navigation on an existing spec in `packages/e2e/tests/` (mirror its fixtures + selectors).

- [ ] **Step 3: Run e2e locally**

Run: `cd packages/e2e && npx playwright test song-menu.spec.ts`
Expected: PASS. Then restore fixtures: `git checkout packages/e2e/fixtures` (local Playwright runs dirty tracked FLAC fixtures — project memory).

- [ ] **Step 4: Confirm CI picks it up**

Verify `.github/workflows/ci.yml`'s `e2e` job runs `packages/e2e` specs by glob (new file auto-included). No workflow edit needed unless the job enumerates files explicitly — if it does, add the new spec.

- [ ] **Step 5: Full gate run**

Run from repo root:
```bash
bun run typecheck && bun run lint
cd packages/web && npx vitest run
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/app/components/track-row/track-row.component.html packages/e2e/tests/song-menu.spec.ts
git commit -m "test(web): e2e for unified song row menu + remove flow"
```

---

## Self-Review notes

- **Spec coverage:** §1 data model → Tasks 3–4. §2 SongMenuService → Task 5, consumed in 6–8. §3 remove/deletedSongIds → Tasks 5–7. §4 TrackInfo host → Task 2. §5 selection (Downloads + canPreserve) → Task 7. §6 ConfirmService → Task 1. Testing → each task + Task 9. Docs → Task 5 (`docs/song-actions.md` + CLAUDE.md).
- **Bulk-action parity note:** the plan wires the selection-bar `canPreserve`; existing bulk Play/Queue/Add/Download/Delete flags already exist. Bulk radio intentionally omitted (per spec).
- **Type consistency:** `SongContext`, `TrackInfoTarget`, `queueNext`/`startRadio`, `BaseSong.albumId`, `ConfirmService.ask` are defined in Tasks 1–5 and referenced with the same names in Tasks 6–8.
- **Known follow-up (out of scope):** album-detail bulk-delete still uses its own selection-bar delete path; this plan leaves it functional and doesn't force it through SongMenuService (which is single-song). Fine — the shared *bulk* delete already lives in the selection bar.

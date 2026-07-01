# Auto-Hunt + Toast Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Find Album → open modal → click Download" flow with an automatic best-match download (≥60% confidence) behind a 3-second cancellable countdown, surfaced via a new global toast notification system.

**Architecture:** A new `ToastService` (root-provided, signal-based) manages active toasts and countdown timers. A `ToastOutletComponent` at the app root renders them above the mini-player. A new `AutoHuntService` runs the two-phase Soulseek hunt headlessly, picks the best candidate, shows a countdown toast, and dispatches the download — calling `openManual()` when the user steers away. The existing `AlbumHuntModalComponent` is preserved as the "Choose Manually" escape hatch.

**Tech Stack:** Angular 22 signals, Vitest, Tailwind CSS, existing `DownloadsApiService`, `TransferService`, `classifyHuntDownloadResult`/`classifyHuntDownloadError` from `lib/hunt-download-outcome`.

## Global Constraints

- Angular standalone components only — no NgModules
- All signals: `signal()`, `computed()`, `effect()` — no RxJS in new service/component logic (use `firstValueFrom()` only to bridge HTTP Observables)
- No explicit `any` in tests — use typed mocks: `vi.fn() as ReturnType<typeof vi.fn>`
- Test files use `vi.fn()` for mocks, `TestBed` for DI, `of()`/`throwError()` from rxjs for HTTP stubs
- No `Co-Authored-By` or Claude attribution in commits
- Run `bun run typecheck` and `ng test --run` after every task before committing

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `packages/web/src/app/lib/merge-candidates.ts` | Pure `mergeCandidates()` function (extracted from modal) |
| Create | `packages/web/src/app/lib/merge-candidates.spec.ts` | Unit tests for merge logic |
| Modify | `packages/web/src/app/components/album-hunt-modal/album-hunt-modal.component.ts` | Import `mergeCandidates` from lib; remove inline definition |
| Create | `packages/web/src/app/services/toast.service.ts` | Toast queue, countdown timers, auto-dismiss |
| Create | `packages/web/src/app/services/toast.service.spec.ts` | Unit tests |
| Create | `packages/web/src/app/components/toast-outlet/toast-outlet.component.ts` | Purely presentational; renders `toastService.toasts()` |
| Create | `packages/web/src/app/components/toast-outlet/toast-outlet.component.html` | Toast list markup + progress bar |
| Create | `packages/web/src/app/components/toast-outlet/toast-outlet.component.spec.ts` | Rendering + action button tests |
| Modify | `packages/web/src/app/app.ts` | Import `ToastOutletComponent`; add `<app-toast-outlet />` to template |
| Create | `packages/web/src/app/services/auto-hunt.service.ts` | Headless hunt + countdown toast orchestration |
| Create | `packages/web/src/app/services/auto-hunt.service.spec.ts` | State-machine unit tests |
| Modify | `packages/web/src/app/pages/library/artist-detail.component.ts` | Replace `openHunt` body with `autoHunt.hunt()` |
| Modify | `packages/web/src/app/pages/search/search.component.ts` | Same in `huntCatalogAlbum` |
| Modify | `packages/web/src/app/pages/search/search.component.spec.ts` | Update resolve test; add `AutoHuntService` mock |

---

## Task 1: Extract `mergeCandidates` to shared lib

**Files:**
- Create: `packages/web/src/app/lib/merge-candidates.ts`
- Create: `packages/web/src/app/lib/merge-candidates.spec.ts`
- Modify: `packages/web/src/app/components/album-hunt-modal/album-hunt-modal.component.ts`

**Interfaces:**
- Produces: `mergeCandidates(base: FolderCandidate[], extra: FolderCandidate[]): FolderCandidate[]` — consumed by Task 4 (`AutoHuntService`) and the modal

- [ ] **Step 1: Write failing tests**

`packages/web/src/app/lib/merge-candidates.spec.ts`:
```ts
import { mergeCandidates } from './merge-candidates';
import type { FolderCandidate } from '../services/api/api-types';

function c(username: string, directory: string, matchPct: number): FolderCandidate {
  return {
    username,
    directory,
    files: [],
    matchedTracks: 0,
    totalTracks: 10,
    matchPct,
    format: 'MP3',
    estimatedSizeMb: 0,
    isLive: false,
    freeUploadSlots: 1,
    queueLength: 0,
    uploadSpeed: 0,
  } as FolderCandidate;
}

describe('mergeCandidates', () => {
  it('returns base candidates when extra is empty', () => {
    const base = [c('u1', '/A', 90), c('u2', '/B', 80)];
    expect(mergeCandidates(base, [])).toEqual(base);
  });

  it('de-duplicates by username::directory, keeping higher matchPct', () => {
    const base = [c('u1', '/A', 80)];
    const extra = [c('u1', '/A', 95)];
    const result = mergeCandidates(base, extra);
    expect(result).toHaveLength(1);
    expect(result[0].matchPct).toBe(95);
  });

  it('keeps lower-pct instance from base when extra is lower', () => {
    const base = [c('u1', '/A', 90)];
    const extra = [c('u1', '/A', 70)];
    expect(mergeCandidates(base, extra)[0].matchPct).toBe(90);
  });

  it('sorts merged results descending by matchPct', () => {
    const base = [c('u1', '/A', 70)];
    const extra = [c('u2', '/B', 95), c('u3', '/C', 50)];
    const result = mergeCandidates(base, extra);
    expect(result.map((r) => r.matchPct)).toEqual([95, 70, 50]);
  });

  it('handles disjoint sets with no duplicates', () => {
    const base = [c('u1', '/A', 80)];
    const extra = [c('u2', '/B', 90)];
    expect(mergeCandidates(base, extra)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/web && ng test --run --reporter=verbose 2>&1 | grep "merge-candidates"
```
Expected: `mergeCandidates` is not defined

- [ ] **Step 3: Create the lib file**

`packages/web/src/app/lib/merge-candidates.ts`:
```ts
import type { FolderCandidate } from '../services/api/api-types';

export function mergeCandidates(
  base: FolderCandidate[],
  extra: FolderCandidate[],
): FolderCandidate[] {
  const byKey = new Map<string, FolderCandidate>();
  for (const c of [...base, ...extra]) {
    const key = `${c.username}::${c.directory}`;
    const prev = byKey.get(key);
    if (!prev || c.matchPct > prev.matchPct) byKey.set(key, c);
  }
  return [...byKey.values()].sort((a, b) => b.matchPct - a.matchPct);
}
```

- [ ] **Step 4: Update the modal to import from lib**

In `packages/web/src/app/components/album-hunt-modal/album-hunt-modal.component.ts`:

Add import (near other lib imports at top):
```ts
import { mergeCandidates } from '../../lib/merge-candidates';
```

Remove the inline `mergeCandidates` function at the bottom of the file (lines 403–411 — the entire standalone function after the class closing `}`).

In `startHunt()`, where it calls `mergeCandidates(...)` — the call site stays identical, just now it references the imported function.

- [ ] **Step 5: Run tests and typecheck**

```bash
cd packages/web && ng test --run 2>&1 | tail -5
bun run typecheck 2>&1 | tail -10
```
Expected: all pass, 0 type errors

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/app/lib/merge-candidates.ts \
        packages/web/src/app/lib/merge-candidates.spec.ts \
        packages/web/src/app/components/album-hunt-modal/album-hunt-modal.component.ts
git commit -m "refactor(web): extract mergeCandidates to shared lib"
```

---

## Task 2: ToastService

**Files:**
- Create: `packages/web/src/app/services/toast.service.ts`
- Create: `packages/web/src/app/services/toast.service.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ToastAction { label: string; callback: () => void; }
  interface ToastConfig {
    message: string;
    kind: 'info' | 'success' | 'error';
    actions?: ToastAction[];
    countdown?: number;   // seconds; first action fires on expiry
    duration?: number;    // seconds auto-dismiss, default 4 (ignored if countdown set)
  }
  interface Toast extends ToastConfig { id: string; }
  class ToastService {
    toasts: Signal<Toast[]>;
    getCountdownPct(id: string): number;  // 100 → 0 over countdown seconds
    show(config: ToastConfig): string;    // returns toast ID
    dismiss(id: string): void;
  }
  ```

- [ ] **Step 1: Write failing tests**

`packages/web/src/app/services/toast.service.spec.ts`:
```ts
import { TestBed } from '@angular/core/testing';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { ToastService } from './toast.service';

describe('ToastService', () => {
  let svc: ToastService;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({});
    svc = TestBed.inject(ToastService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('show() adds a toast and returns an ID', () => {
    const id = svc.show({ message: 'Hello', kind: 'info' });
    expect(typeof id).toBe('string');
    expect(svc.toasts().find((t) => t.id === id)?.message).toBe('Hello');
  });

  it('dismiss() removes the toast by ID', () => {
    const id = svc.show({ message: 'Hi', kind: 'success' });
    svc.dismiss(id);
    expect(svc.toasts().find((t) => t.id === id)).toBeUndefined();
  });

  it('auto-dismisses non-countdown toasts after duration (default 4s)', () => {
    const id = svc.show({ message: 'Auto', kind: 'info' });
    expect(svc.toasts().find((t) => t.id === id)).toBeDefined();
    vi.advanceTimersByTime(4000);
    expect(svc.toasts().find((t) => t.id === id)).toBeUndefined();
  });

  it('respects custom duration', () => {
    const id = svc.show({ message: 'Custom', kind: 'info', duration: 2 });
    vi.advanceTimersByTime(1999);
    expect(svc.toasts().find((t) => t.id === id)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(svc.toasts().find((t) => t.id === id)).toBeUndefined();
  });

  it('getCountdownPct() returns 100 at start and decreases toward 0', () => {
    const id = svc.show({ message: 'Count', kind: 'info', countdown: 3 });
    expect(svc.getCountdownPct(id)).toBe(100);
    vi.advanceTimersByTime(1500);
    const pct = svc.getCountdownPct(id);
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(100);
  });

  it('fires first action and dismisses when countdown expires', () => {
    const cb = vi.fn();
    const id = svc.show({
      message: 'Count',
      kind: 'info',
      countdown: 3,
      actions: [{ label: 'Go', callback: cb }],
    });
    vi.advanceTimersByTime(3000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(svc.toasts().find((t) => t.id === id)).toBeUndefined();
  });

  it('countdown toasts do not auto-dismiss early on non-countdown timer path', () => {
    const cb = vi.fn();
    const id = svc.show({
      message: 'Count',
      kind: 'info',
      countdown: 10,
      actions: [{ label: 'Go', callback: cb }],
    });
    vi.advanceTimersByTime(4000); // default auto-dismiss would fire at 4s
    expect(svc.toasts().find((t) => t.id === id)).toBeDefined();
    expect(cb).not.toHaveBeenCalled();
  });

  it('caps at 3 active toasts, evicting oldest non-countdown toast', () => {
    const id1 = svc.show({ message: '1', kind: 'info', duration: 60 });
    const id2 = svc.show({ message: '2', kind: 'info', duration: 60 });
    const id3 = svc.show({ message: '3', kind: 'info', duration: 60 });
    svc.show({ message: '4', kind: 'info', duration: 60 });
    const ids = svc.toasts().map((t) => t.id);
    expect(ids).not.toContain(id1);
    expect(ids).toContain(id2);
    expect(ids).toContain(id3);
    expect(ids).toHaveLength(3);
  });

  it('does not evict countdown toasts when at capacity', () => {
    const cdId = svc.show({ message: 'CD', kind: 'info', countdown: 10 });
    svc.show({ message: '2', kind: 'info', duration: 60 });
    svc.show({ message: '3', kind: 'info', duration: 60 });
    svc.show({ message: '4', kind: 'info', duration: 60 }); // evicts oldest non-countdown
    expect(svc.toasts().find((t) => t.id === cdId)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/web && ng test --run --reporter=verbose 2>&1 | grep "ToastService"
```
Expected: `ToastService` not found

- [ ] **Step 3: Create ToastService**

`packages/web/src/app/services/toast.service.ts`:
```ts
import { Injectable, signal } from '@angular/core';

export interface ToastAction {
  label: string;
  callback: () => void;
}

export interface ToastConfig {
  message: string;
  kind: 'info' | 'success' | 'error';
  actions?: ToastAction[];
  countdown?: number;
  duration?: number;
}

export interface Toast extends ToastConfig {
  id: string;
}

const MAX_TOASTS = 3;
const TICK_MS = 50;

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private countdownPcts = signal<Record<string, number>>({});
  private timers = new Map<string, ReturnType<typeof setInterval>>();

  getCountdownPct(id: string): number {
    return this.countdownPcts()[id] ?? 100;
  }

  show(config: ToastConfig): string {
    const id = crypto.randomUUID();
    this.toasts.update((prev) => {
      const next = [...prev, { ...config, id }];
      if (next.length > MAX_TOASTS) {
        const evictIdx = next.findIndex((t) => !t.countdown);
        if (evictIdx !== -1) {
          const evicted = next[evictIdx];
          this._clearTimer(evicted.id);
          next.splice(evictIdx, 1);
        }
      }
      return next;
    });

    if (config.countdown) {
      const totalMs = config.countdown * 1000;
      let elapsed = 0;
      const interval = setInterval(() => {
        elapsed += TICK_MS;
        const pct = Math.max(0, 100 - (elapsed / totalMs) * 100);
        this.countdownPcts.update((prev) => ({ ...prev, [id]: pct }));
        if (elapsed >= totalMs) {
          this._clearTimer(id);
          config.actions?.[0]?.callback();
          this.dismiss(id);
        }
      }, TICK_MS);
      this.timers.set(id, interval);
    } else {
      const durationMs = (config.duration ?? 4) * 1000;
      const timer = setTimeout(() => {
        this._clearTimer(id);
        this.dismiss(id);
      }, durationMs) as unknown as ReturnType<typeof setInterval>;
      this.timers.set(id, timer);
    }

    return id;
  }

  dismiss(id: string): void {
    this._clearTimer(id);
    this.toasts.update((prev) => prev.filter((t) => t.id !== id));
    this.countdownPcts.update((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  private _clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearInterval(timer);
      this.timers.delete(id);
    }
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

```bash
cd packages/web && ng test --run 2>&1 | tail -5
bun run typecheck 2>&1 | tail -10
```
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/services/toast.service.ts \
        packages/web/src/app/services/toast.service.spec.ts
git commit -m "feat(web): add ToastService with countdown and auto-dismiss"
```

---

## Task 3: ToastOutletComponent + wire into App

**Files:**
- Create: `packages/web/src/app/components/toast-outlet/toast-outlet.component.ts`
- Create: `packages/web/src/app/components/toast-outlet/toast-outlet.component.html`
- Create: `packages/web/src/app/components/toast-outlet/toast-outlet.component.spec.ts`
- Modify: `packages/web/src/app/app.ts`

**Interfaces:**
- Consumes: `ToastService.toasts()`, `ToastService.getCountdownPct(id)`, `ToastService.dismiss(id)`
- Produces: `<app-toast-outlet />` selector, mounted at app root

- [ ] **Step 1: Write failing tests**

`packages/web/src/app/components/toast-outlet/toast-outlet.component.spec.ts`:
```ts
import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { ToastOutletComponent } from './toast-outlet.component';
import { ToastService } from '../../services/toast.service';
import type { Toast } from '../../services/toast.service';

function makeToast(overrides: Partial<Toast> = {}): Toast {
  return {
    id: 'toast-1',
    message: 'Test message',
    kind: 'info',
    ...overrides,
  };
}

describe('ToastOutletComponent', () => {
  const dismiss = vi.fn();
  const toastsSignal = signal<Toast[]>([]);

  function setup() {
    TestBed.configureTestingModule({
      imports: [ToastOutletComponent],
      providers: [
        {
          provide: ToastService,
          useValue: {
            toasts: toastsSignal,
            getCountdownPct: () => 75,
            dismiss,
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(ToastOutletComponent);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    dismiss.mockClear();
    toastsSignal.set([]);
  });

  it('renders nothing when there are no toasts', () => {
    const fixture = setup();
    expect(fixture.nativeElement.querySelectorAll('[data-testid="toast"]').length).toBe(0);
  });

  it('renders a toast message', () => {
    toastsSignal.set([makeToast({ message: 'Hello world' })]);
    const fixture = setup();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Hello world');
  });

  it('renders action buttons and calls their callbacks on click', () => {
    const cb = vi.fn();
    toastsSignal.set([
      makeToast({ actions: [{ label: 'Do it', callback: cb }] }),
    ]);
    const fixture = setup();
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('[data-testid="toast-action-0"]') as HTMLButtonElement;
    btn.click();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('renders a countdown progress bar when countdown is set', () => {
    toastsSignal.set([makeToast({ countdown: 3 })]);
    const fixture = setup();
    fixture.detectChanges();
    const bar = fixture.nativeElement.querySelector('[data-testid="toast-progress"]');
    expect(bar).not.toBeNull();
  });

  it('applies error kind styling', () => {
    toastsSignal.set([makeToast({ kind: 'error' })]);
    const fixture = setup();
    fixture.detectChanges();
    const toast = fixture.nativeElement.querySelector('[data-testid="toast"]');
    expect(toast?.className).toContain('border-red');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/web && ng test --run --reporter=verbose 2>&1 | grep "ToastOutlet"
```
Expected: component not found

- [ ] **Step 3: Create the component**

`packages/web/src/app/components/toast-outlet/toast-outlet.component.ts`:
```ts
import { Component, inject } from '@angular/core';
import { ToastService } from '../../services/toast.service';

@Component({
  selector: 'app-toast-outlet',
  standalone: true,
  templateUrl: './toast-outlet.component.html',
})
export class ToastOutletComponent {
  readonly toastService = inject(ToastService);
}
```

- [ ] **Step 4: Create the template**

`packages/web/src/app/components/toast-outlet/toast-outlet.component.html`:
```html
@if (toastService.toasts().length) {
  <div class="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] md:bottom-24
              left-0 right-0 flex flex-col items-center gap-2 px-4 z-[60]
              pointer-events-none">
    @for (toast of toastService.toasts(); track toast.id) {
      <div
        data-testid="toast"
        class="pointer-events-auto w-full max-w-sm rounded-xl shadow-lg border
               bg-theme-surface text-sm overflow-hidden
               {{ toast.kind === 'error' ? 'border-red-500/40' :
                  toast.kind === 'success' ? 'border-green-500/30' :
                  'border-theme' }}">

        <!-- Progress bar (countdown only) -->
        @if (toast.countdown) {
          <div data-testid="toast-progress"
               class="h-0.5 bg-theme-surface-2">
            <div class="h-full bg-blue-400 transition-none"
                 [style.width.%]="toastService.getCountdownPct(toast.id)"></div>
          </div>
        }

        <div class="flex items-start gap-3 px-3 py-2.5">
          <!-- Icon -->
          <span class="mt-0.5 shrink-0 text-base
                       {{ toast.kind === 'error' ? 'text-red-400' :
                          toast.kind === 'success' ? 'text-green-400' :
                          'text-blue-400' }}">
            {{ toast.kind === 'error' ? '✕' : toast.kind === 'success' ? '✓' : 'ℹ' }}
          </span>

          <!-- Message -->
          <p class="flex-1 text-theme-primary leading-snug pt-0.5">{{ toast.message }}</p>
        </div>

        <!-- Actions -->
        @if (toast.actions?.length) {
          <div class="flex gap-1 px-3 pb-2.5 justify-end">
            @for (action of toast.actions; track $index) {
              <button
                [attr.data-testid]="'toast-action-' + $index"
                (click)="action.callback()"
                class="px-2.5 py-1 rounded-lg text-xs font-medium transition-colors
                       {{ $index === 0 && toast.countdown
                          ? 'bg-blue-500/20 text-blue-300 hover:bg-blue-500/30'
                          : 'text-theme-secondary hover:text-theme-primary hover:bg-theme-surface-2' }}">
                {{ action.label }}
              </button>
            }
          </div>
        }
      </div>
    }
  </div>
}
```

- [ ] **Step 5: Wire outlet into App**

`packages/web/src/app/app.ts` — add import and outlet to template:
```ts
import { Component, inject, effect } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { SetupService } from './services/setup.service';
import { AuthService } from './services/auth.service';
import { RemotePlaybackService } from './services/remote-playback.service';
import { ToastOutletComponent } from './components/toast-outlet/toast-outlet.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastOutletComponent],
  template: `<router-outlet /><app-toast-outlet />`,
})
export class App {
  private setup = inject(SetupService);
  private auth = inject(AuthService);
  private router = inject(Router);
  private remotePlayback = inject(RemotePlaybackService);

  constructor() {
    this.remotePlayback.initialize();

    effect(() => {
      if (!this.setup.checked()) return;
      if (this.setup.isOffline() && this.auth.token()) {
        this.router.navigate(['/downloads']);
      } else if (this.setup.status()?.needsSetup) {
        this.router.navigate(['/setup']);
      }
    });
  }
}
```

- [ ] **Step 6: Run tests and typecheck**

```bash
cd packages/web && ng test --run 2>&1 | tail -5
bun run typecheck 2>&1 | tail -10
```
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/app/components/toast-outlet/ \
        packages/web/src/app/app.ts
git commit -m "feat(web): add ToastOutletComponent, mount at app root"
```

---

## Task 4: AutoHuntService

**Files:**
- Create: `packages/web/src/app/services/auto-hunt.service.ts`
- Create: `packages/web/src/app/services/auto-hunt.service.spec.ts`

**Interfaces:**
- Consumes: `ToastService.show()`, `ToastService.dismiss()`, `DownloadsApiService.huntAlbumBase()`, `.huntAlbumSkew()`, `.huntDownload()`, `TransferService.kickPoll()`, `mergeCandidates()`, `classifyHuntDownloadResult()`, `classifyHuntDownloadError()`
- Produces:
  ```ts
  class AutoHuntService {
    hunt(album: DiscographyAlbum, artistName: string, openManual: () => void): void;
  }
  ```

- [ ] **Step 1: Write failing tests**

`packages/web/src/app/services/auto-hunt.service.spec.ts`:
```ts
import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { AutoHuntService } from './auto-hunt.service';
import { DownloadsApiService } from './api/downloads-api.service';
import { TransferService } from './transfer.service';
import { ToastService } from './toast.service';
import type { DiscographyAlbum, FolderCandidate } from './api/api-types';

const ALBUM: DiscographyAlbum = {
  lidarrId: 42,
  foreignAlbumId: 'fa42',
  title: 'Wish You Were Here',
  localAlbumId: undefined,
} as DiscographyAlbum;

function candidate(matchPct: number, username = 'peer1'): FolderCandidate {
  return {
    username,
    directory: `/Music/${username}`,
    files: [{ filename: 'track1.flac', size: 1000 }],
    matchedTracks: 10,
    totalTracks: 10,
    matchPct,
    format: 'FLAC',
    estimatedSizeMb: 100,
    isLive: false,
    freeUploadSlots: 1,
    queueLength: 0,
    uploadSpeed: 1,
  } as FolderCandidate;
}

describe('AutoHuntService', () => {
  const huntAlbumBase = vi.fn();
  const huntAlbumSkew = vi.fn();
  const huntDownload = vi.fn();
  const kickPoll = vi.fn();
  const show = vi.fn<Parameters<ToastService['show']>, ReturnType<ToastService['show']>>();
  const dismiss = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    huntAlbumBase.mockReset();
    huntAlbumSkew.mockReset();
    huntDownload.mockReset();
    kickPoll.mockReset();
    show.mockReset();
    dismiss.mockReset();
    show.mockReturnValue('toast-id');

    TestBed.configureTestingModule({
      providers: [
        AutoHuntService,
        { provide: DownloadsApiService, useValue: { huntAlbumBase, huntAlbumSkew, huntDownload } },
        { provide: TransferService, useValue: { kickPoll } },
        { provide: ToastService, useValue: { show, dismiss } },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function svc(): AutoHuntService {
    return TestBed.inject(AutoHuntService);
  }

  it('shows a countdown toast when best match is ≥60%', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
    );
    huntDownload.mockReturnValue(of({ queued: 1 }));

    const service = svc();
    service.hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve(); // flush microtask queue

    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Wish You Were Here'),
        countdown: 3,
        kind: 'info',
      }),
    );
  });

  it('auto-downloads when countdown expires', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
    );
    huntDownload.mockReturnValue(of({ queued: 1 }));

    // Capture the first-action callback (the auto-download)
    let downloadCb: (() => void) | undefined;
    show.mockImplementation((config) => {
      downloadCb = config.actions?.[0]?.callback;
      return 'toast-id';
    });

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();

    downloadCb?.();
    await Promise.resolve();

    expect(huntDownload).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        selected: expect.objectContaining({ username: 'peer1' }),
      }),
      false,
    );
  });

  it('calls kickPoll and shows success toast after successful download', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
    );
    huntDownload.mockReturnValue(of({ queued: 1 }));

    let downloadCb: (() => void) | undefined;
    show.mockImplementation((config) => {
      downloadCb = config.actions?.[0]?.callback;
      return 'toast-id';
    });

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();
    downloadCb?.();
    await Promise.resolve();

    expect(kickPoll).toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'success', message: expect.stringContaining('Wish You Were Here') }),
    );
  });

  it('calls openManual() when "Choose Manually" action is invoked', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
    );
    const openManual = vi.fn();
    let manualCb: (() => void) | undefined;
    show.mockImplementation((config) => {
      // "Choose Manually" is the last action on the countdown toast
      manualCb = config.actions?.at(-1)?.callback;
      return 'toast-id';
    });

    svc().hunt(ALBUM, 'Pink Floyd', openManual);
    await Promise.resolve();
    manualCb?.();

    expect(openManual).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledWith('toast-id');
  });

  it('shows error toast when best match is <60%', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(45)], totalTracks: 10, skewNeeded: false }),
    );

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();

    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'error',
        message: expect.stringContaining('Wish You Were Here'),
      }),
    );
    expect(huntDownload).not.toHaveBeenCalled();
  });

  it('shows error toast when no candidates are found', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [], totalTracks: 10, skewNeeded: false }),
    );

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();

    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });

  it('shows error toast when hunt throws', async () => {
    huntAlbumBase.mockReturnValue(throwError(() => new Error('network error')));

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();

    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });

  it('shows info toast (not error) on 409 already-downloading', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
    );
    huntDownload.mockReturnValue(
      throwError(() => ({ error: { error: 'already-downloading' } })),
    );

    let downloadCb: (() => void) | undefined;
    show.mockImplementation((config) => {
      downloadCb = config.actions?.[0]?.callback;
      return 'toast-id';
    });

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();
    downloadCb?.();
    await Promise.resolve();

    const lastCall = show.mock.calls.at(-1)?.[0];
    expect(lastCall?.kind).toBe('info');
  });

  it('shows info toast (not error) on 409 already-complete', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
    );
    huntDownload.mockReturnValue(of({ queued: 0, alreadyComplete: true }));

    let downloadCb: (() => void) | undefined;
    show.mockImplementation((config) => {
      downloadCb = config.actions?.[0]?.callback;
      return 'toast-id';
    });

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();
    downloadCb?.();
    await Promise.resolve();

    const lastCall = show.mock.calls.at(-1)?.[0];
    expect(lastCall?.kind).toBe('info');
  });

  it('ignores a second hunt() call for the same lidarrId while one is in flight', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [candidate(85)], totalTracks: 10, skewNeeded: false }),
    );
    huntDownload.mockReturnValue(of({ queued: 1 }));

    const service = svc();
    service.hunt(ALBUM, 'Pink Floyd', vi.fn());
    service.hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();

    expect(huntAlbumBase).toHaveBeenCalledTimes(1);
  });

  it('runs skew phase when base reports skewNeeded', async () => {
    huntAlbumBase.mockReturnValue(
      of({ candidates: [], totalTracks: 10, skewNeeded: true }),
    );
    huntAlbumSkew.mockReturnValue(of({ candidates: [candidate(75)] }));
    huntDownload.mockReturnValue(of({ queued: 1 }));

    svc().hunt(ALBUM, 'Pink Floyd', vi.fn());
    await Promise.resolve();

    expect(huntAlbumSkew).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ artistName: 'Pink Floyd' }),
    );
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ countdown: 3 }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/web && ng test --run --reporter=verbose 2>&1 | grep "AutoHuntService"
```
Expected: `AutoHuntService` not found

- [ ] **Step 3: Create AutoHuntService**

`packages/web/src/app/services/auto-hunt.service.ts`:
```ts
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DownloadsApiService } from './api/downloads-api.service';
import { TransferService } from './transfer.service';
import { ToastService } from './toast.service';
import type { DiscographyAlbum, FolderCandidate } from './api/api-types';
import { mergeCandidates } from '../lib/merge-candidates';
import {
  classifyHuntDownloadResult,
  classifyHuntDownloadError,
} from '../lib/hunt-download-outcome';
import { baseQueries, skewedQueries } from '../lib/hunt-queries';

const AUTO_THRESHOLD = 60;
const COUNTDOWN_SECONDS = 3;

@Injectable({ providedIn: 'root' })
export class AutoHuntService {
  private api = inject(DownloadsApiService);
  private transfer = inject(TransferService);
  private toasts = inject(ToastService);

  private inFlight = new Set<number>();

  hunt(album: DiscographyAlbum, artistName: string, openManual: () => void): void {
    if (this.inFlight.has(album.lidarrId)) return;
    this.inFlight.add(album.lidarrId);
    void this._run(album, artistName, openManual).finally(() => {
      this.inFlight.delete(album.lidarrId);
    });
  }

  private async _run(
    album: DiscographyAlbum,
    artistName: string,
    openManual: () => void,
  ): Promise<void> {
    let candidates: FolderCandidate[] = [];

    try {
      const baseResult = await firstValueFrom(
        this.api.huntAlbumBase(album.lidarrId, {
          artistName,
          albumTitle: album.title,
          skewSearch: true,
        }),
      );
      candidates = baseResult.candidates;

      if (baseResult.skewNeeded) {
        const skewResult = await firstValueFrom(
          this.api.huntAlbumSkew(album.lidarrId, { artistName, albumTitle: album.title }),
        );
        candidates = mergeCandidates(baseResult.candidates, skewResult.candidates);
      }
    } catch {
      this.toasts.show({
        message: `Search failed for "${album.title}"`,
        kind: 'error',
        actions: [
          { label: 'Dismiss', callback: () => {} },
          { label: 'Find Manually', callback: () => { openManual(); } },
        ],
      });
      return;
    }

    const best = candidates[0];
    if (!best || best.matchPct < AUTO_THRESHOLD) {
      this.toasts.show({
        message: `No confident match found for "${album.title}"`,
        kind: 'error',
        actions: [
          { label: 'Dismiss', callback: () => {} },
          { label: 'Find Manually', callback: () => { openManual(); } },
        ],
      });
      return;
    }

    const toastId = this.toasts.show({
      message: `Best match found — downloading "${album.title}" in ${COUNTDOWN_SECONDS}s`,
      kind: 'info',
      countdown: COUNTDOWN_SECONDS,
      actions: [
        {
          label: 'Download Now',
          callback: () => { void this._download(toastId, album, candidates, openManual); },
        },
        {
          label: 'Cancel',
          callback: () => { this.toasts.dismiss(toastId); },
        },
        {
          label: 'Choose Manually',
          callback: () => { this.toasts.dismiss(toastId); openManual(); },
        },
      ],
    });

    // Rewrite the first action with the resolved toastId now that show() has returned.
    // (The closure above captures toastId via let-binding after show() returns.)
  }

  private async _download(
    countdownToastId: string,
    album: DiscographyAlbum,
    candidates: FolderCandidate[],
    openManual: () => void,
  ): Promise<void> {
    this.toasts.dismiss(countdownToastId);

    const [best, ...rest] = candidates;
    const toFiles = (c: FolderCandidate) => c.files.map((f) => ({ filename: f.filename, size: f.size }));

    try {
      const res = await firstValueFrom(
        this.api.huntDownload(
          album.lidarrId,
          {
            selected: {
              username: best.username,
              directory: best.directory,
              files: toFiles(best),
            },
            alternates: rest.map((c) => ({
              username: c.username,
              directory: c.directory,
              files: toFiles(c),
            })),
            localAlbumId: album.localAlbumId,
          },
          false,
        ),
      );

      if (classifyHuntDownloadResult(res) === 'already-complete') {
        this.toasts.show({
          message: `You already have "${album.title}"`,
          kind: 'info',
        });
        return;
      }

      this.transfer.kickPoll();
      this.toasts.show({
        message: `Downloading "${album.title}"`,
        kind: 'success',
      });
    } catch (err) {
      const outcome = classifyHuntDownloadError(err);
      if (outcome.kind === 'already-complete') {
        this.toasts.show({ message: `You already have "${album.title}"`, kind: 'info' });
      } else if (outcome.kind === 'already-downloading') {
        this.toasts.show({ message: `"${album.title}" is already downloading`, kind: 'info' });
      } else {
        this.toasts.show({
          message: `Download failed for "${album.title}"`,
          kind: 'error',
          actions: [
            { label: 'Dismiss', callback: () => {} },
            { label: 'Find Manually', callback: () => { openManual(); } },
          ],
        });
      }
    }
  }
}
```

> **Note on the `toastId` self-reference:** `show()` returns the ID synchronously after updating the signal. The `toastId` variable is declared with `const` from the return value and captured in the action callbacks. The "Download Now" and "Cancel" callbacks capture the correct ID because they are closures formed after `show()` returns.

- [ ] **Step 4: Run tests and typecheck**

```bash
cd packages/web && ng test --run 2>&1 | tail -5
bun run typecheck 2>&1 | tail -10
```
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/services/auto-hunt.service.ts \
        packages/web/src/app/services/auto-hunt.service.spec.ts
git commit -m "feat(web): add AutoHuntService — headless hunt with countdown toast"
```

---

## Task 5: Wire callers + update specs

**Files:**
- Modify: `packages/web/src/app/pages/library/artist-detail.component.ts`
- Modify: `packages/web/src/app/pages/search/search.component.ts`
- Modify: `packages/web/src/app/pages/search/search.component.spec.ts`

**Interfaces:**
- Consumes: `AutoHuntService.hunt(album, artistName, openManual)`

- [ ] **Step 1: Update artist-detail.component.ts**

Add import at the top with other service imports:
```ts
import { AutoHuntService } from '../../services/auto-hunt.service';
```

Add injection after existing `inject()` calls (around line 63):
```ts
private autoHunt = inject(AutoHuntService);
```

Replace the `openHunt` method body:
```ts
openHunt(album: DiscographyAlbum): void {
  const artistName = this.artist()?.name ?? '';
  this.autoHunt.hunt(album, artistName, () => this.huntingAlbum.set(album));
}
```

(The `huntingAlbum` signal, `closeHunt()`, and `<app-album-hunt-modal>` wiring in the template are unchanged.)

- [ ] **Step 2: Update search.component.ts**

Add import:
```ts
import { AutoHuntService } from '../../services/auto-hunt.service';
```

Add injection:
```ts
private autoHunt = inject(AutoHuntService);
```

In `huntCatalogAlbum()`, replace the lines that call `this.huntingAlbum.set({...})` with:
```ts
      const discAlbum: DiscographyAlbum = {
        lidarrId: resolved.lidarrAlbumId,
        foreignAlbumId: album.foreignAlbumId,
        title: resolved.title || album.title,
        releaseDate: album.year,
        albumType: album.albumType,
        secondaryTypes: album.secondaryTypes,
        totalTracks: resolved.totalTracks || album.trackCount,
        localTrackCount: 0,
        status: 'missing',
        coverArtUrl: album.coverUrl,
        tracks: [],
      };
      const artistName = resolved.artistName || album.artistName;
      this.huntingArtistName.set(artistName);
      this.autoHunt.hunt(discAlbum, artistName, () => this.huntingAlbum.set(discAlbum));
```

(Keep `huntingArtistName` assignment — the manual modal fallback still reads it via `[artistName]="huntingArtistName()"` in the template.)

- [ ] **Step 3: Update search.component.spec.ts**

Find the existing test:
```ts
it('resolves a searched album and opens the album-hunt modal with the real Lidarr id', async () => {
```

This test currently checks `component.huntingAlbum()` — which is no longer set by `huntCatalogAlbum` (only by the `openManual` callback). Replace it with a test that verifies `autoHunt.hunt` is called with the resolved album:

In the `setup()` helper of the spec, add `AutoHuntService` to the providers:
```ts
import { AutoHuntService } from '../../services/auto-hunt.service';
// ...
// Inside setup():
const autoHunt = { hunt: vi.fn() };
// Add to providers array:
{ provide: AutoHuntService, useValue: autoHunt },
// Return autoHunt from setup():
return { component, /* ...existing... */, autoHunt };
```

Replace the test:
```ts
it('resolves a searched album and calls autoHunt.hunt() with the real Lidarr id', async () => {
  const { component, autoHunt } = setup();

  await component.huntCatalogAlbum(CATALOG_ALBUM);

  expect(autoHunt.hunt).toHaveBeenCalledWith(
    expect.objectContaining({ lidarrId: 55, totalTracks: 10 }),
    'Pink Floyd',
    expect.any(Function),
  );
  expect(component.huntingArtistName()).toBe('Pink Floyd');
  expect(component.resolvingAlbum()).toBeNull();
});
```

The "surfaces a resolve failure without opening the modal" test remains valid (it tests the error path where `autoHunt.hunt` is never called — verify `autoHunt.hunt` was not called there too):
```ts
it('surfaces a resolve failure without opening the modal', async () => {
  const { component, autoHunt } = setup({
    catalogResolve: () => throwError(() => new Error('not yet available')),
  });

  await component.huntCatalogAlbum(CATALOG_ALBUM);

  expect(autoHunt.hunt).not.toHaveBeenCalled();
  expect(component.resolveError()).toMatch(/not yet available/);
});
```

- [ ] **Step 4: Run all tests and typecheck**

```bash
cd packages/web && ng test --run 2>&1 | tail -10
bun run typecheck 2>&1 | tail -10
```
Expected: all pass, 0 errors

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/pages/library/artist-detail.component.ts \
        packages/web/src/app/pages/search/search.component.ts \
        packages/web/src/app/pages/search/search.component.spec.ts
git commit -m "feat(web): wire AutoHuntService into Find Album flow"
```

---

## Self-Review

**Spec coverage:**
- ✅ Toast system with countdown, auto-dismiss, action buttons, capacity cap → Task 2 + 3
- ✅ `ToastOutletComponent` fixed above mini-player → Task 3
- ✅ `AutoHuntService.hunt()` with `openManual` callback → Task 4
- ✅ ≥60% confidence threshold → Task 4 (`AUTO_THRESHOLD = 60`)
- ✅ 3-second countdown toast with Cancel / Download Now / Choose Manually → Task 4
- ✅ Error toasts: no match, hunt throws, download error → Task 4
- ✅ Already-complete and already-downloading as info (not error) → Task 4
- ✅ Concurrency guard → Task 4
- ✅ Skew phase runs when `skewNeeded` → Task 4
- ✅ `mergeCandidates` extracted and shared → Task 1
- ✅ artist-detail and search callers updated → Task 5
- ✅ search spec updated → Task 5
- ✅ All public methods have tests → Tasks 1–5

**Type consistency check:**
- `ToastService.show(config: ToastConfig): string` — used correctly in AutoHuntService
- `ToastService.dismiss(id: string)` — used correctly
- `AutoHuntService.hunt(album: DiscographyAlbum, artistName: string, openManual: () => void): void` — matches caller sites
- `mergeCandidates(base: FolderCandidate[], extra: FolderCandidate[]): FolderCandidate[]` — matches Task 4 usage
- `huntAlbumBase` / `huntAlbumSkew` / `huntDownload` — signatures verified against `DownloadsApiService`

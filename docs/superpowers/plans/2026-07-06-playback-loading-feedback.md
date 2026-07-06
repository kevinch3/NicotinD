# Playback Loading Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the web UI visible feedback for slow (HDD-backed) playback operations: a buffering spinner on player play buttons, an instant current-track indicator on track rows, and a buffered-ranges band on the seek bar.

**Architecture:** One source of truth — a `buffering` signal (plus a 250 ms-delayed `bufferingVisible` and a `bufferedRanges` signal) on `PlayerService`, driven by native `<audio>` events wired in `PlayerComponent.bindAudioListeners` and by the track-load effect. All surfaces (mini-player, Now Playing, `TrackRowComponent`, `SeekBarComponent`) derive from those signals. Pure, DI-free helpers in `lib/` carry the computable logic because the web JIT vitest harness can't drive `input()` signals.

**Tech Stack:** Angular v22 standalone + signals, Tailwind + theme CSS vars (`styles.css`), vitest (`bun run test` in `packages/web`), Playwright e2e (`packages/e2e`).

**Spec:** `docs/superpowers/specs/2026-07-06-playback-loading-feedback-design.md`

## Global Constraints

- Branch: `feature/playback-loading-feedback` (already created off master; spec committed).
- Node >= 22.22.3 required for web build/tests: run `nvm use 22.22.3` before any `ng`/vitest command if the default node is older.
- Web tests: `cd packages/web && bun run test` (vitest run; a pretest script builds changelog.json).
- Conventional Commits enforced by commitlint. **No** `Co-Authored-By` / Claude attribution trailers in commits.
- Never run `bun run format` repo-wide (dirties the whole repo); format only files you touched (prettier defaults, match surrounding style).
- Do not re-add per-source UI or touch acquisition code — this feature is player/library-list UI only.
- Buffering state is **active-device only**: when this tab is a remote controller, `buffering` must stay/become `false`. The playback WS protocol is not extended.
- New e2e-targeted elements get `data-testid` attributes.

---

### Task 1: Pure buffered-range helpers (`lib/buffered-ranges.ts`)

**Files:**
- Create: `packages/web/src/app/lib/buffered-ranges.ts`
- Create: `packages/web/src/app/lib/buffered-ranges.spec.ts`

**Interfaces:**
- Consumes: nothing (DI-free, pure).
- Produces:
  - `interface BufferedRange { start: number; end: number }` (seconds)
  - `interface BufferedSegment { left: number; width: number }` (0..100 percent)
  - `computeBufferedSegments(ranges: BufferedRange[], duration: number): BufferedSegment[]`
  - `bufferedGradient(segments: BufferedSegment[]): string | null`
  - Used by Task 2 (`BufferedRange` type on the service) and Task 6 (seek bar).

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/app/lib/buffered-ranges.spec.ts`:

```ts
import { computeBufferedSegments, bufferedGradient } from './buffered-ranges';

describe('computeBufferedSegments', () => {
  it('returns [] for zero/unknown duration', () => {
    expect(computeBufferedSegments([{ start: 0, end: 10 }], 0)).toEqual([]);
    expect(computeBufferedSegments([{ start: 0, end: 10 }], NaN)).toEqual([]);
  });

  it('converts ranges to percent segments', () => {
    expect(computeBufferedSegments([{ start: 0, end: 50 }], 200)).toEqual([
      { left: 0, width: 25 },
    ]);
  });

  it('handles multiple ranges and keeps them sorted by start', () => {
    const segs = computeBufferedSegments(
      [
        { start: 150, end: 200 },
        { start: 0, end: 50 },
      ],
      200,
    );
    expect(segs).toEqual([
      { left: 0, width: 25 },
      { left: 75, width: 25 },
    ]);
  });

  it('clamps ranges that exceed the duration', () => {
    expect(computeBufferedSegments([{ start: 100, end: 500 }], 200)).toEqual([
      { left: 50, width: 50 },
    ]);
  });

  it('drops empty, inverted, and sub-0.5% sliver ranges', () => {
    expect(computeBufferedSegments([{ start: 10, end: 10 }], 200)).toEqual([]);
    expect(computeBufferedSegments([{ start: 20, end: 10 }], 200)).toEqual([]);
    // 0.4 of 200s = 0.2% — invisible at seek-bar widths, skip.
    expect(computeBufferedSegments([{ start: 0, end: 0.4 }], 200)).toEqual([]);
  });
});

describe('bufferedGradient', () => {
  it('returns null when there is nothing to paint', () => {
    expect(bufferedGradient([])).toBeNull();
  });

  it('builds a hard-stop gradient painting each segment over the base track color', () => {
    const g = bufferedGradient([{ left: 25, width: 50 }]);
    expect(g).toBe(
      'linear-gradient(to right, ' +
        'var(--theme-surface-2) 25%, var(--seek-buffered-color) 25%, ' +
        'var(--seek-buffered-color) 75%, var(--theme-surface-2) 75%)',
    );
  });

  it('chains stops for multiple segments', () => {
    const g = bufferedGradient([
      { left: 0, width: 10 },
      { left: 50, width: 10 },
    ]);
    expect(g).toContain('var(--seek-buffered-color) 0%');
    expect(g).toContain('var(--theme-surface-2) 10%');
    expect(g).toContain('var(--seek-buffered-color) 50%');
    expect(g).toContain('var(--theme-surface-2) 60%');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && bun run test -- buffered-ranges`
Expected: FAIL — `Cannot find module './buffered-ranges'` (or equivalent resolve error).

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/app/lib/buffered-ranges.ts`:

```ts
/**
 * Buffered-range helpers behind app-seek-bar's "loaded so far" band.
 *
 * The <audio> element reports `buffered` as TimeRanges in seconds; these
 * convert them into 0..100% segments and a CSS multi-stop gradient painted
 * under the seek fill (YouTube-style), so HDD users can tell a safe seek
 * target from one that will stall. Kept DI-free so they're unit-testable
 * without instantiating the component (the web JIT harness can't drive
 * input() signals).
 */

export interface BufferedRange {
  start: number;
  end: number;
}

export interface BufferedSegment {
  /** Left edge, 0..100 (% of duration). */
  left: number;
  /** Width, 0..100 (% of duration). */
  width: number;
}

/** Sub-0.5% segments are invisible at seek-bar widths — skip them. */
const MIN_SEGMENT_PERCENT = 0.5;

export function computeBufferedSegments(
  ranges: BufferedRange[],
  duration: number,
): BufferedSegment[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const segments: BufferedSegment[] = [];
  for (const r of ranges) {
    const start = Math.min(Math.max(0, r.start), duration);
    const end = Math.min(Math.max(0, r.end), duration);
    if (end <= start) continue;
    const left = (start / duration) * 100;
    const width = ((end - start) / duration) * 100;
    if (width < MIN_SEGMENT_PERCENT) continue;
    segments.push({ left, width });
  }
  return segments.sort((a, b) => a.left - b.left);
}

/**
 * Hard-stop gradient painting buffered segments (--seek-buffered-color) over
 * the base track (--theme-surface-2). Null when nothing is buffered — callers
 * fall back to the plain track background via the CSS var default.
 */
export function bufferedGradient(segments: BufferedSegment[]): string | null {
  if (segments.length === 0) return null;
  const base = 'var(--theme-surface-2)';
  const band = 'var(--seek-buffered-color)';
  const stops: string[] = [];
  for (const s of segments) {
    const start = s.left;
    const end = Math.min(100, s.left + s.width);
    stops.push(`${base} ${start}%`, `${band} ${start}%`, `${band} ${end}%`, `${base} ${end}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
```

Note the first test expects exact string output — the stop order above produces
`base 25%, band 25%, band 75%, base 75%` for a single mid-track segment, which
paints: base 0→25%, band 25→75%, base 75→100%.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && bun run test -- buffered-ranges`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/lib/buffered-ranges.ts packages/web/src/app/lib/buffered-ranges.spec.ts
git commit -m "feat(web): add buffered-range segment + gradient helpers"
```

---

### Task 2: PlayerService buffering state

**Files:**
- Modify: `packages/web/src/app/services/player.service.ts`
- Test: `packages/web/src/app/services/player.service.spec.ts` (append a describe block)

**Interfaces:**
- Consumes: `BufferedRange` from `../lib/buffered-ranges` (Task 1).
- Produces (used by Tasks 3–6):
  - `readonly buffering: WritableSignal<boolean>` — raw, exact state.
  - `readonly bufferingVisible: WritableSignal<boolean>` — delayed-on (250 ms), instant-off.
  - `readonly bufferedRanges: WritableSignal<BufferedRange[]>`
  - `setBuffering(value: boolean): void`
  - `setBufferedRanges(ranges: BufferedRange[]): void`

- [ ] **Step 1: Write the failing test**

Append to `packages/web/src/app/services/player.service.spec.ts` (inside the top-level `describe('PlayerService')`, after the existing describes; import `vi` from `'vitest'` at the top if not already imported):

```ts
describe('buffering state', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('setBuffering(true) sets the raw signal immediately', () => {
    service.setBuffering(true);
    expect(service.buffering()).toBe(true);
    expect(service.bufferingVisible()).toBe(false);
  });

  it('bufferingVisible turns on only after the 250ms delay (no flash on fast tracks)', () => {
    service.setBuffering(true);
    vi.advanceTimersByTime(249);
    expect(service.bufferingVisible()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(service.bufferingVisible()).toBe(true);
  });

  it('never shows the spinner when buffering clears before the delay', () => {
    service.setBuffering(true);
    vi.advanceTimersByTime(100);
    service.setBuffering(false);
    vi.advanceTimersByTime(500);
    expect(service.bufferingVisible()).toBe(false);
  });

  it('setBuffering(false) hides the spinner immediately', () => {
    service.setBuffering(true);
    vi.advanceTimersByTime(250);
    expect(service.bufferingVisible()).toBe(true);
    service.setBuffering(false);
    expect(service.buffering()).toBe(false);
    expect(service.bufferingVisible()).toBe(false);
  });

  it('re-asserting buffering(true) does not restart the pending delay', () => {
    service.setBuffering(true);
    vi.advanceTimersByTime(200);
    service.setBuffering(true); // e.g. waiting fires again
    vi.advanceTimersByTime(50);
    expect(service.bufferingVisible()).toBe(true);
  });

  it('setBufferedRanges stores ranges; clear() resets buffering and ranges', () => {
    service.setBufferedRanges([{ start: 0, end: 30 }]);
    expect(service.bufferedRanges()).toEqual([{ start: 0, end: 30 }]);
    service.setBuffering(true);
    vi.advanceTimersByTime(250);
    service.clear();
    expect(service.buffering()).toBe(false);
    expect(service.bufferingVisible()).toBe(false);
    expect(service.bufferedRanges()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && bun run test -- player.service`
Expected: FAIL — `service.setBuffering is not a function`.

- [ ] **Step 3: Write the implementation**

In `packages/web/src/app/services/player.service.ts`:

Add the import at the top:

```ts
import type { BufferedRange } from '../lib/buffered-ranges';
```

Add next to `RADIO_MIN_QUEUE` (module scope):

```ts
// How long buffering must persist before surfaces show a spinner. HDD
// spin-up/seek (multi-second) is the target; cached tracks that start in
// <250ms must never flash a loader.
const BUFFERING_VISIBLE_DELAY_MS = 250;
```

Add signals after `readonly autoplayBlocked = signal(false);`:

```ts
// Audio is loading/stalled on the active device (set by PlayerComponent from
// native <audio> events). `bufferingVisible` is the render-safe view: it only
// turns on after BUFFERING_VISIBLE_DELAY_MS, but turns off instantly.
readonly buffering = signal(false);
readonly bufferingVisible = signal(false);
// Snapshot of audio.buffered (seconds) for the seek bar's loaded-so-far band.
readonly bufferedRanges = signal<BufferedRange[]>([]);
private bufferingVisibleTimer: ReturnType<typeof setTimeout> | null = null;
```

Add methods after `setAutoplayBlocked` (end of class):

```ts
setBuffering(value: boolean): void {
  this.buffering.set(value);
  if (value) {
    if (this.bufferingVisibleTimer !== null || this.bufferingVisible()) return;
    this.bufferingVisibleTimer = setTimeout(() => {
      this.bufferingVisibleTimer = null;
      if (this.buffering()) this.bufferingVisible.set(true);
    }, BUFFERING_VISIBLE_DELAY_MS);
  } else {
    if (this.bufferingVisibleTimer !== null) {
      clearTimeout(this.bufferingVisibleTimer);
      this.bufferingVisibleTimer = null;
    }
    this.bufferingVisible.set(false);
  }
}

setBufferedRanges(ranges: BufferedRange[]): void {
  this.bufferedRanges.set(ranges);
}
```

In the existing `clear()` method, add before `localStorage.removeItem(...)`:

```ts
this.setBuffering(false);
this.bufferedRanges.set([]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && bun run test -- player.service`
Expected: PASS (new block green, existing tests untouched).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/services/player.service.ts packages/web/src/app/services/player.service.spec.ts
git commit -m "feat(web): add buffering + bufferedRanges state to PlayerService"
```

---

### Task 3: PlayerComponent audio-event wiring

**Files:**
- Modify: `packages/web/src/app/components/player/player.component.ts`
- Test: `packages/web/src/app/components/player/player.component.spec.ts` (append a describe block)

**Interfaces:**
- Consumes: `player.setBuffering(boolean)`, `player.setBufferedRanges(ranges)` (Task 2).
- Produces: the signals become *live* — after this task, `buffering`/`bufferingVisible`/`bufferedRanges` reflect real audio state. No new API.

**Wiring rules (from the spec):**
- New `src` assignment (any path) → `setBuffering(true)` + `setBufferedRanges([])`.
- `waiting`, `seeking` → `setBuffering(true)`.
- `stalled` → `setBuffering(true)` **only if** `audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA` (stalled also fires on harmless network hiccups with plenty buffered).
- `playing`, `canplay`, `error` → `setBuffering(false)`.
- `progress` → snapshot `audio.buffered` into `setBufferedRanges`.
- Not the active device / no track → `setBuffering(false)` + `setBufferedRanges([])`.
- `handlePlayRejection` → `setBuffering(false)` (the "Tap to resume" banner replaces the spinner).

- [ ] **Step 1: Write the failing test**

Append to `packages/web/src/app/components/player/player.component.spec.ts` (inside the top-level `describe('PlayerComponent')`, after the `expand gesture` block):

```ts
// ─── Buffering feedback (HDD-aware loaders) ────────────────────────────────

describe('buffering feedback', () => {
  it('waiting event sets buffering', () => {
    fakeAudio.dispatchEvent(new Event('waiting'));
    expect(playerService.buffering()).toBe(true);
  });

  it('seeking event sets buffering', () => {
    fakeAudio.dispatchEvent(new Event('seeking'));
    expect(playerService.buffering()).toBe(true);
  });

  it('playing event clears buffering', () => {
    playerService.setBuffering(true);
    fakeAudio.dispatchEvent(new Event('playing'));
    expect(playerService.buffering()).toBe(false);
  });

  it('canplay clears buffering (covers seeks while paused)', () => {
    playerService.setBuffering(true);
    fakeAudio.dispatchEvent(new Event('canplay'));
    expect(playerService.buffering()).toBe(false);
  });

  it('error clears buffering so the spinner cannot spin forever', () => {
    playerService.setBuffering(true);
    fakeAudio.dispatchEvent(new Event('error'));
    expect(playerService.buffering()).toBe(false);
  });

  it('stalled sets buffering only when playback genuinely lacks data', () => {
    Object.defineProperty(fakeAudio, 'readyState', { value: 4, configurable: true });
    fakeAudio.dispatchEvent(new Event('stalled'));
    expect(playerService.buffering()).toBe(false);

    Object.defineProperty(fakeAudio, 'readyState', { value: 2, configurable: true });
    fakeAudio.dispatchEvent(new Event('stalled'));
    expect(playerService.buffering()).toBe(true);
  });

  it('loading a new track sets buffering and clears stale buffered ranges', () => {
    playerService.setBufferedRanges([{ start: 0, end: 10 }]);
    playerService.currentTrack.set(TRACK);
    fixture.detectChanges();
    expect(playerService.buffering()).toBe(true);
    expect(playerService.bufferedRanges()).toEqual([]);
  });

  it('clears buffering when this device stops being the active one', () => {
    playerService.setBuffering(true);
    isActiveDevice.set(false);
    fixture.detectChanges();
    expect(playerService.buffering()).toBe(false);
  });

  it('progress event snapshots audio.buffered into the service', () => {
    Object.defineProperty(fakeAudio, 'buffered', {
      value: { length: 2, start: (i: number) => [0, 60][i], end: (i: number) => [30, 90][i] },
      configurable: true,
    });
    fakeAudio.dispatchEvent(new Event('progress'));
    expect(playerService.bufferedRanges()).toEqual([
      { start: 0, end: 30 },
      { start: 60, end: 90 },
    ]);
  });

  it('handlePlayRejection clears buffering (banner replaces the spinner)', () => {
    playerService.setBuffering(true);
    setVisibility('visible');
    component['handlePlayRejection']();
    expect(playerService.buffering()).toBe(false);
  });

  it('ended-with-queue advance flags buffering for the incoming track', () => {
    playerService.currentTrack.set(TRACK);
    playerService.queue.set([TRACK_2]);
    playerService.setBuffering(false);

    fakeAudio.dispatchEvent(new Event('ended'));

    expect(playerService.buffering()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && bun run test -- player.component`
Expected: FAIL — the waiting/seeking/progress/new-track assertions fail (signals stay false / ranges stay stale).

- [ ] **Step 3: Write the implementation**

In `packages/web/src/app/components/player/player.component.ts`:

**(a) Effect 1** — three edits:

In the `if (!isActive)` block, add before `return;`:

```ts
this.player.setBuffering(false);
this.player.setBufferedRanges([]);
```

In the `if (track)` branch, add immediately after `this.player.setDuration(track.duration ?? 0);`:

```ts
// New load beginning — flag it before any bytes move so track rows and
// play buttons can acknowledge instantly (HDD loads take seconds).
this.player.setBuffering(true);
this.player.setBufferedRanges([]);
```

In the final `else` (no track) branch, add after `this.player.setDuration(0);`:

```ts
this.player.setBuffering(false);
this.player.setBufferedRanges([]);
```

**(b) `handlePlayRejection`** — add as the first line of the method:

```ts
this.player.setBuffering(false);
```

**(c) `bindAudioListeners`** — add these listener functions after the existing `onPause` definition:

```ts
const onWaiting = () => this.player.setBuffering(true);
const onSeeking = () => this.player.setBuffering(true);
// stalled also fires on harmless network hiccups while plenty is buffered —
// only treat it as buffering when playback genuinely can't proceed.
const onStalled = () => {
  if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) this.player.setBuffering(true);
};
const onPlaying = () => this.player.setBuffering(false);
const onCanPlay = () => this.player.setBuffering(false);
const onError = () => this.player.setBuffering(false);
const onProgress = () => {
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < audio.buffered.length; i++) {
    ranges.push({ start: audio.buffered.start(i), end: audio.buffered.end(i) });
  }
  this.player.setBufferedRanges(ranges);
};
```

Register them alongside the existing `addEventListener` calls:

```ts
audio.addEventListener('waiting', onWaiting);
audio.addEventListener('seeking', onSeeking);
audio.addEventListener('stalled', onStalled);
audio.addEventListener('playing', onPlaying);
audio.addEventListener('canplay', onCanPlay);
audio.addEventListener('error', onError);
audio.addEventListener('progress', onProgress);
```

And extend `this.audioListenerCleanups` with the matching removals:

```ts
() => audio.removeEventListener('waiting', onWaiting),
() => audio.removeEventListener('seeking', onSeeking),
() => audio.removeEventListener('stalled', onStalled),
() => audio.removeEventListener('playing', onPlaying),
() => audio.removeEventListener('canplay', onCanPlay),
() => audio.removeEventListener('error', onError),
() => audio.removeEventListener('progress', onProgress),
```

**(d) `onEnded`** — both advance paths load a new src:

In the **preloaded standby swap** path, add immediately before `standby.play().catch(...)`:

```ts
// Usually clears within ms (the standby is buffered) — the 250ms visibility
// delay means no spinner unless the swap actually stalls.
this.player.setBuffering(true);
this.player.setBufferedRanges([]);
```

In the **fallback (not preloaded)** path, add as the first lines of the `playNext` closure (before `audio.play().catch(...)`):

```ts
this.player.setBuffering(true);
this.player.setBufferedRanges([]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && bun run test -- player.component`
Expected: PASS — new block green **and** all pre-existing PlayerComponent tests still green (screen-lock, gestures, layout, regressions).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/components/player/player.component.ts packages/web/src/app/components/player/player.component.spec.ts
git commit -m "feat(web): drive buffering + buffered-ranges signals from audio events"
```

---

### Task 4: Buffering spinner on play/pause buttons

**Files:**
- Modify: `packages/web/src/app/components/player/player.component.ts` (one computed)
- Modify: `packages/web/src/app/components/player/player.component.html`
- Modify: `packages/web/src/app/components/now-playing/now-playing.component.ts` (one computed)
- Modify: `packages/web/src/app/components/now-playing/now-playing.component.html`
- Test: `packages/web/src/app/components/player/player.component.spec.ts` (append)

**Interfaces:**
- Consumes: `player.bufferingVisible()` (Task 2), `isActiveDevice` (existing).
- Produces: `showBuffering: Signal<boolean>` on both components (template-only consumers).

- [ ] **Step 1: Write the failing test**

Append inside the `buffering feedback` describe from Task 3:

```ts
it('shows a spinner on the play/pause button while buffering is visible', () => {
  playerService.bufferingVisible.set(true);
  fixture.detectChanges();
  const btn = (fixture.nativeElement as HTMLElement).querySelector(
    '[data-testid="player-playpause"]',
  ) as HTMLElement;
  expect(btn.getAttribute('data-buffering')).toBe('true');
  expect(btn.querySelector('.animate-spin')).not.toBeNull();
});

it('shows no spinner when buffering is not visible', () => {
  playerService.bufferingVisible.set(false);
  fixture.detectChanges();
  const btn = (fixture.nativeElement as HTMLElement).querySelector(
    '[data-testid="player-playpause"]',
  ) as HTMLElement;
  expect(btn.getAttribute('data-buffering')).toBe('false');
  expect(btn.querySelector('.animate-spin')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && bun run test -- player.component`
Expected: FAIL — `data-buffering` attribute is null, no spinner element.

- [ ] **Step 3: Write the implementation**

**`player.component.ts`** — add a computed next to `showPlaying`:

```ts
readonly showBuffering = computed(() => this.isActiveDevice() && this.player.bufferingVisible());
```

**`player.component.html`** — replace the Play/Pause button's icon block:

```html
<!-- Play/Pause -->
<button
  (click)="handlePlayPause()"
  data-testid="player-playpause"
  [attr.data-playing]="showPlaying()"
  [attr.data-buffering]="showBuffering()"
  class="w-8 h-8 rounded-full bg-theme-inverse text-theme-inverse flex items-center justify-center hover:opacity-90 transition"
>
  @if (showBuffering()) {
    <span class="inline-block w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin"></span>
  } @else if (showPlaying()) {
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  } @else {
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5,3 19,12 5,21" />
    </svg>
  }
</button>
```

**`now-playing.component.ts`** — add the same computed next to its `showPlaying` (line ~110):

```ts
readonly showBuffering = computed(() => this.isActiveDevice() && this.player.bufferingVisible());
```

**`now-playing.component.html`** — the sheet's Play/Pause button (line ~172) gets the same treatment, sized for the 56px button:

```html
<!-- Play/Pause -->
<button
  (click)="handlePlayPause()"
  [attr.data-buffering]="showBuffering()"
  class="w-14 h-14 rounded-full bg-zinc-100 text-zinc-900 flex items-center justify-center hover:bg-zinc-200 transition"
>
  @if (showBuffering()) {
    <span class="inline-block w-6 h-6 border-[3px] border-current border-t-transparent rounded-full animate-spin"></span>
  } @else if (showPlaying()) {
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  } @else {
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="6,3 20,12 6,21" />
    </svg>
  }
</button>
```

There is a **second** play/pause button in `now-playing.component.html` (line ~431, the lyrics-panel mini controls) — apply the same `@if (showBuffering())` first branch there too, with a spinner sized to match its icons.

The button stays clickable while buffering — tapping it pauses (acts as cancel).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && bun run test -- player.component && bun run test -- now-playing`
Expected: PASS, including any existing now-playing tests.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/components/player/ packages/web/src/app/components/now-playing/
git commit -m "feat(web): show buffering spinner on play/pause buttons"
```

---

### Task 5: Track-row current-track indicator + instant click acknowledgment

**Files:**
- Create: `packages/web/src/app/lib/row-playback-state.ts`
- Create: `packages/web/src/app/lib/row-playback-state.spec.ts`
- Modify: `packages/web/src/app/components/track-row/track-row.component.ts`
- Modify: `packages/web/src/app/components/track-row/track-row.component.html`
- Modify: `packages/web/src/styles.css` (eq-bars animation)
- Create: `packages/web/src/app/components/track-row/track-row.component.spec.ts`

**Interfaces:**
- Consumes: `player.currentTrack()`, `player.bufferingVisible()`, `player.isPlaying()` (Task 2 + existing).
- Produces:
  - `type RowPlaybackState = 'buffering' | 'playing' | 'paused'`
  - `rowPlaybackState(currentTrackId: string | undefined, rowTrackId: string, bufferingVisible: boolean, isPlaying: boolean): RowPlaybackState | null`
  - Track-row DOM contract for e2e (Task 7): root carries `data-testid="track-row"` and `data-playback-state` (absent when not current); title button carries `data-testid="track-row-title"`.

- [ ] **Step 1: Write the failing helper test**

Create `packages/web/src/app/lib/row-playback-state.spec.ts`:

```ts
import { rowPlaybackState } from './row-playback-state';

describe('rowPlaybackState', () => {
  it('is null when the row is not the current track', () => {
    expect(rowPlaybackState(undefined, 't1', false, false)).toBeNull();
    expect(rowPlaybackState('other', 't1', true, true)).toBeNull();
  });

  it('reports buffering ahead of playing (spinner wins while loading)', () => {
    expect(rowPlaybackState('t1', 't1', true, true)).toBe('buffering');
  });

  it('reports playing / paused from isPlaying once buffering settles', () => {
    expect(rowPlaybackState('t1', 't1', false, true)).toBe('playing');
    expect(rowPlaybackState('t1', 't1', false, false)).toBe('paused');
  });
});
```

- [ ] **Step 2: Run helper test to verify it fails**

Run: `cd packages/web && bun run test -- row-playback-state`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

Create `packages/web/src/app/lib/row-playback-state.ts`:

```ts
/**
 * Which indicator a track row shows for the *current* track: spinner while
 * audio buffers (HDD loads take seconds), equalizer bars while playing,
 * static bars while paused; null for every non-current row. DI-free so it's
 * testable without the component (the web JIT harness can't drive input()
 * signals).
 */
export type RowPlaybackState = 'buffering' | 'playing' | 'paused';

export function rowPlaybackState(
  currentTrackId: string | undefined,
  rowTrackId: string,
  bufferingVisible: boolean,
  isPlaying: boolean,
): RowPlaybackState | null {
  if (!currentTrackId || currentTrackId !== rowTrackId) return null;
  if (bufferingVisible) return 'buffering';
  return isPlaying ? 'playing' : 'paused';
}
```

Run: `cd packages/web && bun run test -- row-playback-state` → PASS.

- [ ] **Step 4: Write the failing component test**

Create `packages/web/src/app/components/track-row/track-row.component.spec.ts`:

```ts
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrackRowComponent } from './track-row.component';
import { PlayerService, type Track } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { ServerConfigService } from '../../services/server-config.service';

const ROW_TRACK: Track = { id: 't1', title: 'Song One', artist: 'Artist A' };
const OTHER_TRACK: Track = { id: 't2', title: 'Song Two', artist: 'Artist B' };

// The JIT harness can't drive input() signals directly — bind them from a host.
@Component({
  imports: [TrackRowComponent],
  template: `<app-track-row [track]="track" [indexLabel]="3" [showCover]="false" />`,
})
class HostComponent {
  track = ROW_TRACK;
}

describe('TrackRowComponent — current-track indicator', () => {
  function setup() {
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        PlayerService,
        { provide: AuthService, useValue: { token: signal('test-token') } },
        { provide: ServerConfigService, useValue: { apiUrl: (u: string) => u } },
      ],
    });
    const fixture = TestBed.createComponent(HostComponent);
    const player = TestBed.inject(PlayerService);
    player.clear();
    fixture.detectChanges();
    const row = () => fixture.nativeElement.querySelector('[data-testid="track-row"]') as HTMLElement;
    return { fixture, player, row };
  }

  it('shows the index and no playback state when the row is not current', () => {
    const { player, fixture, row } = setup();
    player.currentTrack.set(OTHER_TRACK);
    fixture.detectChanges();
    expect(row().getAttribute('data-playback-state')).toBeNull();
    expect(row().textContent).toContain('3');
    expect(row().querySelector('.eq-bars')).toBeNull();
  });

  it('acknowledges instantly: current + buffering shows a spinner in the index slot', () => {
    const { player, fixture, row } = setup();
    player.currentTrack.set(ROW_TRACK);
    player.bufferingVisible.set(true);
    fixture.detectChanges();
    expect(row().getAttribute('data-playback-state')).toBe('buffering');
    expect(row().querySelector('.animate-spin')).not.toBeNull();
  });

  it('shows animated equalizer bars while playing', () => {
    const { player, fixture, row } = setup();
    player.currentTrack.set(ROW_TRACK);
    player.isPlaying.set(true);
    fixture.detectChanges();
    expect(row().getAttribute('data-playback-state')).toBe('playing');
    const bars = row().querySelector('.eq-bars');
    expect(bars).not.toBeNull();
    expect(bars!.classList.contains('eq-paused')).toBe(false);
  });

  it('shows static bars while paused and accents the title when current', () => {
    const { player, fixture, row } = setup();
    player.currentTrack.set(ROW_TRACK);
    player.isPlaying.set(false);
    fixture.detectChanges();
    expect(row().getAttribute('data-playback-state')).toBe('paused');
    expect(row().querySelector('.eq-bars.eq-paused')).not.toBeNull();
    const title = row().querySelector('[data-testid="track-row-title"] p') as HTMLElement;
    expect(title.classList.contains('text-theme-accent')).toBe(true);
  });
});
```

Run: `cd packages/web && bun run test -- track-row`
Expected: FAIL — no `data-testid="track-row"` element.

- [ ] **Step 5: Implement the component + template + CSS**

**`track-row.component.ts`:**

Add imports:

```ts
import { Component, HostListener, computed, inject, input, output, signal } from '@angular/core';
import { PlayerService } from '../../services/player.service';
import { rowPlaybackState } from '../../lib/row-playback-state';
```

Add to the class (after `readonly auth = inject(AuthService);`):

```ts
readonly player = inject(PlayerService);
```

Add computeds after the `selectedChange` output:

```ts
// Current-track indicator: currentTrack is set synchronously on click, so the
// row acknowledges a tap instantly — before any (HDD-slow) bytes arrive.
readonly playbackState = computed(() =>
  rowPlaybackState(
    this.player.currentTrack()?.id,
    this.track().id,
    this.player.bufferingVisible(),
    this.player.isPlaying(),
  ),
);
readonly isCurrent = computed(() => this.playbackState() !== null);
```

**`track-row.component.html`:**

Root div — add the testid + state attribute:

```html
<div data-testid="track-row" [attr.data-playback-state]="playbackState()"
  [class]="'flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-theme-hover transition group' + (disabled() ? ' opacity-40 pointer-events-none' : '')">
```

Index slot — replace the existing `@else` branch (the `indexLabel` span) with:

```html
} @else if (playbackState() !== null) {
  <span class="w-6 flex items-center justify-end flex-shrink-0">
    @if (playbackState() === 'buffering') {
      <span class="inline-block w-3.5 h-3.5 border-2 border-theme border-t-[var(--theme-accent)] rounded-full animate-spin"></span>
    } @else {
      <span class="eq-bars" [class.eq-paused]="playbackState() === 'paused'" aria-hidden="true">
        <span></span><span></span><span></span>
      </span>
    }
  </span>
} @else {
  <span class="text-xs text-theme-muted w-6 text-right">{{ indexLabel() ?? '' }}</span>
}
```

(The `@if (selectable())` checkbox branch stays first and untouched — multi-select mode wins over the indicator.)

Title button — add the testid and accent:

```html
<button type="button" data-testid="track-row-title" (click)="play.emit()" class="w-full text-left">
  <p class="text-sm truncate" [class.text-theme-accent]="isCurrent()" [class.text-theme-primary]="!isCurrent()">{{ track().title }}</p>
</button>
```

**`styles.css`** — add after the seek-bar block (before "Custom animations"):

```css
/* ─── Track-row playing indicator (app-track-row) ────────────────────────
   Equalizer bars for the current track: animated while playing, frozen
   short while paused. Global CSS because the row is rendered by many hosts
   and the animation must not be re-declared per component. */
.eq-bars {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 12px;
}
.eq-bars > span {
  width: 3px;
  border-radius: 1px;
  background: var(--theme-accent);
  animation: eq-bounce 1s ease-in-out infinite;
}
.eq-bars > span:nth-child(1) { animation-delay: -0.45s; }
.eq-bars > span:nth-child(2) { animation-delay: -0.2s; }
.eq-bars > span:nth-child(3) { animation-delay: 0s; }
.eq-bars.eq-paused > span {
  animation: none;
  height: 4px;
}
@keyframes eq-bounce {
  0%, 100% { height: 4px; }
  50% { height: 12px; }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/web && bun run test -- track-row`
Expected: PASS (4 tests).

Also run the full web suite to catch template fallout in hosts (album-detail, playlist-detail, genre-detail, artist-detail, search all render `app-track-row`; their specs must still pass now that the row injects `PlayerService` — it's `providedIn: 'root'`, so no provider changes should be needed):

Run: `cd packages/web && bun run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/app/lib/row-playback-state.ts packages/web/src/app/lib/row-playback-state.spec.ts packages/web/src/app/components/track-row/ packages/web/src/styles.css
git commit -m "feat(web): current-track indicator with instant click acknowledgment on track rows"
```

---

### Task 6: Seek-bar buffered-ranges band

**Files:**
- Modify: `packages/web/src/app/components/seek-bar/seek-bar.component.ts`
- Modify: `packages/web/src/app/components/seek-bar/seek-bar.component.html`
- Modify: `packages/web/src/styles.css` (track backgrounds)
- Modify: `packages/web/src/app/components/player/player.component.html` (2 × `app-seek-bar`)
- Modify: `packages/web/src/app/components/now-playing/now-playing.component.html` (2 × `app-seek-bar`, lines ~119 and ~409)
- Test: `packages/web/src/app/components/seek-bar/seek-bar.component.spec.ts` (append)

**Interfaces:**
- Consumes: `BufferedRange`, `computeBufferedSegments`, `bufferedGradient` (Task 1); `player.bufferedRanges()` (Task 2).
- Produces: `buffered = input<BufferedRange[]>([])` on `SeekBarComponent`.

- [ ] **Step 1: Write the failing test**

Append to `packages/web/src/app/components/seek-bar/seek-bar.component.spec.ts` (host component defined at module level, after imports — add `import { Component } from '@angular/core';` at the top):

```ts
// Host wrapper because the JIT harness can't drive input() signals directly.
@Component({
  imports: [SeekBarComponent],
  template: `<app-seek-bar [position]="10" [duration]="100" [buffered]="buffered" />`,
})
class BufferedHost {
  buffered = [{ start: 0, end: 50 }];
}

describe('SeekBarComponent — buffered band', () => {
  it('exposes the buffered segments as a gradient CSS var on the input', () => {
    TestBed.configureTestingModule({ imports: [BufferedHost] });
    const fixture = TestBed.createComponent(BufferedHost);
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const bg = input.style.getPropertyValue('--seek-buffered-bg');
    expect(bg).toContain('linear-gradient(to right');
    expect(bg).toContain('var(--seek-buffered-color) 0%');
    expect(bg).toContain('var(--theme-surface-2) 50%');
  });

  it('sets no gradient var when nothing is buffered (falls back to plain track)', () => {
    TestBed.configureTestingModule({ imports: [BufferedHost] });
    const fixture = TestBed.createComponent(BufferedHost);
    fixture.componentInstance.buffered = [];
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    expect(input.style.getPropertyValue('--seek-buffered-bg')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && bun run test -- seek-bar`
Expected: FAIL — `buffered` input does not exist (template binding error).

- [ ] **Step 3: Write the implementation**

**`seek-bar.component.ts`** — add import and members:

```ts
import {
  bufferedGradient,
  computeBufferedSegments,
  type BufferedRange,
} from '../../lib/buffered-ranges';
```

```ts
/** Buffered ranges (seconds) painted as a lighter band under the fill. */
readonly buffered = input<BufferedRange[]>([]);

/** Gradient for the buffered band, or null → CSS falls back to the plain track. */
readonly bufferedBackground = computed(() =>
  bufferedGradient(computeBufferedSegments(this.buffered(), this.duration())),
);
```

**`seek-bar.component.html`** — add the style binding to the input:

```html
[style.--seek-buffered-bg]="bufferedBackground()"
```

(Angular removes the property entirely when the binding is null — the CSS `var(..., fallback)` then applies.)

**`styles.css`** — replace the two track-background rules:

```css
.seek-range::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 9999px;
  /* Layered: accent fill on top of the buffered band (or plain track). A color
     alone can't be a background layer, hence the two-stop gradient fallback. */
  background:
    linear-gradient(
      to right,
      var(--theme-accent) var(--seek-percent, 0%),
      transparent var(--seek-percent, 0%)
    ),
    var(--seek-buffered-bg, linear-gradient(var(--theme-surface-2), var(--theme-surface-2)));
}
.seek-range::-moz-range-track {
  height: 4px;
  border-radius: 9999px;
  /* Firefox paints the accent fill natively via ::-moz-range-progress. */
  background: var(--seek-buffered-bg, linear-gradient(var(--theme-surface-2), var(--theme-surface-2)));
}
```

And define the band color on the `.seek-range` rule itself (var() substitution then resolves against whatever theme is active on the ancestors — no per-theme declarations needed):

```css
.seek-range {
  /* …existing declarations unchanged… */
  /* Buffered band: accent tinted toward the track base so it reads as
     "loaded but not played" in every theme. */
  --seek-buffered-color: color-mix(in srgb, var(--theme-accent) 30%, var(--theme-surface-2));
}
```

**Feed the ranges** — in `player.component.html`, both `<app-seek-bar>` usages (desktop ~line 157, mobile ~line 180) get:

```html
[buffered]="player.bufferedRanges()"
```

In `now-playing.component.html`, both `<app-seek-bar>` usages (~lines 119 and 409) get the same binding. Remote-device safety needs no extra guard: Task 3 clears `bufferedRanges` whenever the device is not active.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && bun run test -- seek-bar && bun run test -- player.component && bun run test -- now-playing`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/components/seek-bar/ packages/web/src/app/components/player/player.component.html packages/web/src/app/components/now-playing/now-playing.component.html packages/web/src/styles.css
git commit -m "feat(web): buffered-ranges band on the seek bar"
```

---

### Task 7: e2e — track row acknowledges click and reaches playing

**Files:**
- Modify: `packages/e2e/tests/playback.spec.ts`

**Interfaces:**
- Consumes: DOM contract from Task 5 (`data-testid="track-row"`, `data-testid="track-row-title"`, `data-playback-state`).
- CI: `playback.spec.ts` already runs in the `e2e` job of `.github/workflows/ci.yml` — no workflow change needed, but verify in Step 3.

- [ ] **Step 1: Write the test**

Append inside `test.describe('playback', ...)` in `packages/e2e/tests/playback.spec.ts`:

```ts
test('track row acknowledges the click and settles into playing state', async ({ page }) => {
  await page.goto('/library');
  await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).click();
  await expect(page).toHaveURL(/\/library\/albums\//);

  const firstRow = page.getByTestId('track-row').first();
  await firstRow.getByTestId('track-row-title').click();

  // Instant acknowledgment: the row carries a playback state right away
  // (buffering while bytes arrive on slow disks, or straight to playing).
  await expect(firstRow).toHaveAttribute('data-playback-state', /buffering|playing/, {
    timeout: 2_000,
  });

  // And settles to playing once audio actually starts.
  await expect(firstRow).toHaveAttribute('data-playback-state', 'playing', {
    timeout: 15_000,
  });
});
```

- [ ] **Step 2: Run the e2e spec**

Run: `cd packages/e2e && bun run test -- playback.spec.ts`
(The Playwright config boots the real server against a throwaway DB + silent-FLAC fixtures; no slskd needed.)
Expected: PASS (2 tests — the existing stream test and the new one).

If the new test fails because the first visible `track-row` is inside a hidden container or the album page uses `showCover`-less rows, debug with `bun run test:headed -- playback.spec.ts` before changing selectors.

- [ ] **Step 3: Verify CI coverage**

Run: `grep -n "playwright\|e2e" .github/workflows/ci.yml | head -20`
Expected: the `e2e` job runs the whole `packages/e2e` Playwright suite (no per-file filter). If it filters files, add `playback.spec.ts` to the filter.

- [ ] **Step 4: Commit**

```bash
git add packages/e2e/tests/playback.spec.ts
git commit -m "test(e2e): track row click acknowledgment and playing state"
```

---

### Task 8: Documentation + final gates

**Files:**
- Modify: `docs/web-ui.md`
- Modify: `CLAUDE.md` (one index line)

- [ ] **Step 1: Write the docs**

Add a section to `docs/web-ui.md` (near the player/theme material):

```markdown
## Playback loading feedback (HDD-aware loaders)

Libraries often sit on HDDs: starting an uncached track or seeking into an
untranscoded region can take multiple seconds. All loading feedback derives
from one source of truth on `PlayerService`:

- `buffering` — raw state. Set synchronously the moment a new track load
  begins (Effect 1 / `onEnded` src assignment in `PlayerComponent`) and from
  native audio events: `waiting`/`seeking` set it, `stalled` sets it only when
  `readyState < HAVE_FUTURE_DATA` (plain `stalled` also fires on harmless
  network hiccups), `playing`/`canplay`/`error` clear it. Active-device only —
  remote-controller tabs always read `false`.
- `bufferingVisible` — the render-safe view: turns on only after 250 ms
  (cached tracks must never flash a spinner), turns off instantly. Surfaces
  bind to this, never to raw `buffering`.
- `bufferedRanges` — snapshot of `audio.buffered` (from `progress` events),
  cleared on every new load and when the device goes remote.

Surfaces:

- **Play/pause buttons** (mini-player + Now Playing, incl. the lyrics-panel
  controls): spinner replaces the icon while `bufferingVisible`; the button
  stays clickable (pause = cancel).
- **Track rows** (`TrackRowComponent`, injected `PlayerService`): the current
  row accents its title and swaps the index number for a spinner (buffering),
  animated `.eq-bars` (playing), or static bars (paused) — logic in the pure
  `rowPlaybackState` helper. Because `currentTrack` is set synchronously on
  click, the row acknowledges a tap before any bytes arrive. E2e contract:
  `data-testid="track-row"`, `data-testid="track-row-title"`,
  `data-playback-state="buffering|playing|paused"`.
- **Seek bar**: `buffered` input renders `bufferedRanges` as a lighter band
  (`--seek-buffered-bg` gradient built by the pure `computeBufferedSegments` +
  `bufferedGradient` helpers in `lib/buffered-ranges.ts`) under the accent
  fill, so users can see what's safe to seek into. Firefox keeps its native
  `::-moz-range-progress` fill; the band rides the track background in both
  engines.

Deliberately out of scope: buffering over the remote-playback WS protocol
(controller tabs show remote state, not remote buffering).
```

- [ ] **Step 2: Add the CLAUDE.md index line**

In `CLAUDE.md` under **Key Design Patterns**, add one line (after the "Native streaming + cover art" bullet):

```markdown
- **Playback loading feedback (HDD-aware)**: one `PlayerService.buffering` signal (250 ms-delayed `bufferingVisible`) drives play-button spinners, the track-row current/buffering indicator (instant click ack), and a seek-bar buffered-ranges band. → [docs/web-ui.md](docs/web-ui.md)
```

- [ ] **Step 3: Run the full gates**

```bash
nvm use 22.22.3
bun run typecheck
bun run lint
cd packages/web && bun run test
cd ../e2e && bun run test -- playback.spec.ts
```

Expected: all green. Fix anything that isn't before committing.

- [ ] **Step 4: Commit**

```bash
git add docs/web-ui.md CLAUDE.md
git commit -m "docs: playback loading feedback pattern"
```

- [ ] **Step 5: Push the branch**

Prod deploys hard-reset this checkout on tag deploys — push early:

```bash
git push -u origin feature/playback-loading-feedback
```

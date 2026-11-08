/**
 * Reveal-on-overflow for a single-line truncated name (#1665). The host keeps
 * its `truncate` and its one text node; when the text does not fit, the host's
 * own `scrollLeft` is animated, so nothing is cloned, nothing reflows and a
 * screen reader still reads the string once. Text that fits never moves.
 *
 * Triggers (owner decision on #1665, docs/design-patterns.md "Names are never
 * unreadably truncated"):
 * - `always` — the playing title: loops while on screen.
 * - `list` — touch: one pass when the row settles in view and is still;
 *   desktop: while hovered or keyboard-focused; TV: while D-pad focused.
 * - `prefers-reduced-motion` — never moves; on touch and TV the first tap
 *   expands the text to wrap. A pointer already has the `title` tooltip.
 */

export type OverflowRevealMode = 'list' | 'always';
export type RevealInput = 'touch' | 'pointer' | 'tv';

/** Reading speed. Constant px/s, so a long title is slower to read, never a blur. */
export const REVEAL_SPEED_PX_S = 40;
/** The return leg carries nothing to read. */
export const REVEAL_RETURN_SPEED_PX_S = 120;
/** Rest at each end before moving. */
export const REVEAL_PAUSE_MS = 1500;
/** How long a row must sit unmoved in view before a touch pass plays. */
export const REVEAL_SETTLE_MS = 600;
/** Share of the host that must be inside the viewport to count as "in view". */
export const REVEAL_IN_VIEW_RATIO = 0.95;

export const REVEAL_ACTIVE_CLASS = 'overflow-reveal-active';
export const REVEAL_EXPANDED_CLASS = 'overflow-reveal-expanded';

/** The clickable/focusable thing a hover or focus on means "this row". */
const ROW_SELECTOR =
  'a[href], button, [role="button"], [role="option"], [role="menuitem"], [role="link"], ' +
  '[tabindex]:not([tabindex="-1"]), li, tr';

export interface RevealEnv {
  reducedMotion(): boolean;
  input(): RevealInput;
  requestFrame(cb: (now: number) => void): number;
  cancelFrame(id: number): void;
  setTimer(cb: () => void, ms: number): number;
  clearTimer(id: number): void;
  /** `inView`: at least `REVEAL_IN_VIEW_RATIO` on screen; `intersecting`: any of it is. */
  observeView?(el: Element, cb: (inView: boolean, intersecting: boolean) => void): () => void;
  observeSize?(el: Element, cb: () => void): () => void;
  observeText?(el: Element, cb: () => void): () => void;
}

/**
 * One IntersectionObserver and one ResizeObserver for every name on the page,
 * not one per row: a long list holds hundreds of them.
 */
function sharedObserver<E>(
  make: (dispatch: (entries: Array<E & { target: Element }>) => void) => {
    observe(el: Element): void;
    unobserve(el: Element): void;
  },
): (el: Element, cb: (entry: E) => void) => () => void {
  const callbacks = new Map<Element, (entry: E) => void>();
  let observer: ReturnType<typeof make> | null = null;
  return (el, cb) => {
    observer ??= make((entries) => {
      for (const e of entries) callbacks.get(e.target)?.(e);
    });
    callbacks.set(el, cb);
    observer.observe(el);
    return () => {
      callbacks.delete(el);
      observer?.unobserve(el);
    };
  };
}

let sharedView: ReturnType<typeof sharedObserver<IntersectionObserverEntry>> | null = null;
let sharedSize: ReturnType<typeof sharedObserver<ResizeObserverEntry>> | null = null;

export function browserRevealEnv(isTv: () => boolean): RevealEnv {
  const media = (q: string): boolean => typeof matchMedia === 'function' && matchMedia(q).matches;
  return {
    reducedMotion: () => media('(prefers-reduced-motion: reduce)'),
    input: () =>
      isTv() ? 'tv' : media('(hover: hover) and (pointer: fine)') ? 'pointer' : 'touch',
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (id) => cancelAnimationFrame(id),
    setTimer: (cb, ms) => setTimeout(cb, ms) as unknown as number,
    clearTimer: (id) => clearTimeout(id),
    observeView:
      typeof IntersectionObserver === 'undefined'
        ? undefined
        : (el, cb) => {
            sharedView ??= sharedObserver<IntersectionObserverEntry>(
              (dispatch) =>
                new IntersectionObserver(dispatch, { threshold: [0, REVEAL_IN_VIEW_RATIO, 1] }),
            );
            return sharedView(el, (e) =>
              cb(e.isIntersecting && e.intersectionRatio >= REVEAL_IN_VIEW_RATIO, e.isIntersecting),
            );
          },
    observeSize:
      typeof ResizeObserver === 'undefined'
        ? undefined
        : (el, cb) => {
            sharedSize ??= sharedObserver<ResizeObserverEntry>(
              (dispatch) => new ResizeObserver(dispatch),
            );
            return sharedSize(el, () => cb());
          },
    observeText:
      typeof MutationObserver === 'undefined'
        ? undefined
        : (el, cb) => {
            const mo = new MutationObserver(() => cb());
            mo.observe(el, { characterData: true, childList: true, subtree: true });
            return () => mo.disconnect();
          },
  };
}

/**
 * Markup built as a string, where no directive can attach (the home mosaic's
 * pooled faces, #1707), marks each truncated name with this attribute instead;
 * the code that writes the markup then calls `attachOverflowReveals` on it.
 */
export const REVEAL_MARKER_ATTR = 'data-overflow-reveal';

/** One `list` reveal per marked name under `root`, all sharing `row`'s hover and focus. */
export function attachOverflowReveals(
  root: ParentNode,
  env: RevealEnv,
  row?: Element,
): OverflowReveal[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(`[${REVEAL_MARKER_ATTR}]`),
    (el) => new OverflowReveal(el, 'list', env, row),
  );
}

type Phase = 'idle' | 'lead' | 'forward' | 'hold' | 'back';

export class OverflowReveal {
  private phase: Phase = 'idle';
  private loop = false;
  private distance = 0;
  private dir = 1;
  private offset = 0;
  private phaseStart = -1;
  private legFrom = 0;
  private frameId: number | null = null;
  private timerId: number | null = null;
  private settleId: number | null = null;
  private inView = true;
  private played = false;
  private hovered = false;
  private focused = false;
  private expanded = false;
  private ownTitle: string | null = null;
  private readonly row: Element;
  private readonly cleanups: Array<() => void> = [];

  /** `row` overrides the nearest-control lookup, for a host with no control above it. */
  constructor(
    private readonly el: HTMLElement,
    private readonly mode: OverflowRevealMode,
    private readonly env: RevealEnv,
    row?: Element,
  ) {
    this.row = row ?? el.closest(ROW_SELECTOR) ?? el.parentElement ?? el;
    const on = (
      target: EventTarget,
      type: string,
      fn: (e: Event) => void,
      capture = false,
    ): void => {
      target.addEventListener(type, fn, capture);
      this.cleanups.push(() => target.removeEventListener(type, fn, capture));
    };
    // Capture: when the host is itself the link or button, its own (click) and
    // routerLink listeners were bound first and would act on the wrapping tap.
    on(el, 'click', (e) => this.onClick(e), true);
    if (mode === 'list') {
      on(this.row, 'mouseenter', () => this.engage('hover', true));
      on(this.row, 'mouseleave', () => this.engage('hover', false));
      // A tap focuses a button too; only keyboard and D-pad focus mean "show me".
      on(this.row, 'focusin', (e) =>
        this.engage('focus', env.input() === 'tv' || focusVisible(e.target)),
      );
      on(this.row, 'focusout', (e) => {
        const next = (e as FocusEvent).relatedTarget as Node | null;
        if (!next || !this.row.contains(next)) this.engage('focus', false);
      });
    }
    const view = env.observeView?.(el, (v, i) => this.onView(v, i));
    if (view) {
      this.inView = false;
      this.cleanups.push(view);
    }
    const size = env.observeSize?.(el, () => this.onResize());
    if (size) this.cleanups.push(size);
    const text = env.observeText?.(el, () => this.onTextChange());
    if (text) this.cleanups.push(text);
    this.refresh();
  }

  destroy(): void {
    this.reset();
    this.clearSettle();
    for (const fn of this.cleanups.splice(0)) fn();
  }

  /** How far the text runs past the box, in px; 0 when it fits. */
  overflow(): number {
    return Math.max(0, this.el.scrollWidth - this.el.clientWidth);
  }

  isAnimating(): boolean {
    return this.phase !== 'idle';
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  // ── triggers ────────────────────────────────────────────────────────────

  private onView(inView: boolean, intersecting = inView): void {
    this.inView = inView;
    if (!inView) {
      this.played = false;
      this.clearSettle();
      this.reset();
      // A wrapped name grows taller and can fall under the in-view ratio by its
      // own growth at a viewport edge; only leaving the screen undoes the wrap.
      if (!intersecting) this.collapse();
      return;
    }
    this.refresh();
  }

  private onResize(): void {
    if (this.expanded) return;
    this.syncTitle();
    if (!this.overflow()) this.reset();
    this.refresh();
  }

  private onTextChange(): void {
    this.played = false;
    this.clearSettle();
    this.reset();
    this.collapse();
    this.syncTitle();
    this.refresh();
  }

  private engage(kind: 'hover' | 'focus', on: boolean): void {
    if (kind === 'hover') this.hovered = on && this.env.input() === 'pointer';
    else this.focused = on;
    if (this.hovered || this.focused) this.start(true);
    else this.stop();
  }

  private onClick(e: Event): void {
    if (!this.env.reducedMotion() || this.env.input() === 'pointer') return;
    if (this.expanded || !this.overflow()) return;
    // A link or button inside the name (an artist credit) keeps its own tap.
    const target = e.target as Element | null;
    const inner = target?.closest?.('a, button');
    if (inner && inner !== this.el && this.el.contains(inner)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.expanded = true;
    this.el.classList.add(REVEAL_EXPANDED_CLASS);
  }

  /** Decide, from the current state, whether a pass should be running. */
  private refresh(): void {
    this.syncTitle();
    if (!this.inView || this.expanded) return;
    if (this.mode === 'always') {
      if (this.overflow()) this.start(true);
      return;
    }
    if (this.hovered || this.focused) {
      this.start(true);
      return;
    }
    if (this.env.input() === 'touch' && !this.played && this.settleId === null) this.awaitSettle();
  }

  /** Touch: wait until the row has stopped moving, then play once. */
  private awaitSettle(): void {
    const before = this.el.getBoundingClientRect();
    this.settleId = this.env.setTimer(() => {
      this.settleId = null;
      if (!this.inView || this.played) return;
      const after = this.el.getBoundingClientRect();
      if (Math.abs(after.top - before.top) > 1 || Math.abs(after.left - before.left) > 1) {
        this.awaitSettle();
        return;
      }
      if (!this.overflow()) return;
      this.played = true;
      this.start(false);
    }, REVEAL_SETTLE_MS);
  }

  private clearSettle(): void {
    if (this.settleId !== null) this.env.clearTimer(this.settleId);
    this.settleId = null;
  }

  // ── the pass ────────────────────────────────────────────────────────────

  private start(loop: boolean): void {
    if (this.env.reducedMotion() || this.expanded || !this.inView) return;
    if (this.phase !== 'idle') {
      this.loop = this.loop || loop;
      if (this.phase === 'back' && loop) this.enter('forward');
      return;
    }
    if (!this.overflow()) return;
    this.loop = loop;
    this.distance = this.overflow();
    this.dir = getComputedStyle(this.el).direction === 'rtl' ? -1 : 1;
    this.enter('lead');
  }

  /** End the pass smoothly: run back to the start and stay there. */
  private stop(): void {
    this.loop = false;
    if (this.phase === 'lead') this.reset();
    else if (this.phase === 'forward' || this.phase === 'hold') this.enter('back');
  }

  /** Snap to rest. Used where the jump cannot be seen (off-screen, new text). */
  private reset(): void {
    this.enter('idle');
    this.loop = false;
    this.paint(0);
  }

  private enter(phase: Phase): void {
    this.clearTimer();
    this.clearFrame();
    this.phase = phase;
    this.phaseStart = -1;
    this.legFrom = this.offset;
    // The ellipsis shows at rest; while the text moves it is clipped instead.
    this.el.classList.toggle(REVEAL_ACTIVE_CLASS, phase !== 'idle' && phase !== 'lead');
    if (phase === 'idle') return;
    if (phase === 'lead' || phase === 'hold') {
      const next: Phase = phase === 'lead' ? 'forward' : 'back';
      this.timerId = this.env.setTimer(() => this.enter(next), REVEAL_PAUSE_MS);
      return;
    }
    this.frameId = this.env.requestFrame((t) => this.tick(t));
  }

  private tick(now: number): void {
    this.frameId = null;
    if (this.phaseStart < 0) this.phaseStart = now;
    const elapsed = (now - this.phaseStart) / 1000;
    if (this.phase === 'forward') {
      this.paint(Math.min(this.distance, this.legFrom + elapsed * REVEAL_SPEED_PX_S));
      if (this.offset >= this.distance) return this.enter('hold');
    } else {
      this.paint(Math.max(0, this.legFrom - elapsed * REVEAL_RETURN_SPEED_PX_S));
      if (this.offset <= 0) return this.enter(this.loop && this.inView ? 'lead' : 'idle');
    }
    this.frameId = this.env.requestFrame((t) => this.tick(t));
  }

  private paint(offset: number): void {
    this.offset = offset;
    this.el.scrollLeft = this.dir * offset;
  }

  private collapse(): void {
    if (!this.expanded) return;
    this.expanded = false;
    this.el.classList.remove(REVEAL_EXPANDED_CLASS);
  }

  /** A `title` carries the full name for a pointer, unless the host has its own. */
  private syncTitle(): void {
    const current = this.el.getAttribute('title');
    if (current !== null && current !== this.ownTitle) return;
    const full =
      this.overflow() || this.expanded
        ? (this.el.textContent ?? '').replace(/\s+/g, ' ').trim()
        : '';
    if (full) {
      this.el.setAttribute('title', full);
      this.ownTitle = full;
    } else if (this.ownTitle !== null) {
      this.el.removeAttribute('title');
      this.ownTitle = null;
    }
  }

  private clearTimer(): void {
    if (this.timerId !== null) this.env.clearTimer(this.timerId);
    this.timerId = null;
  }

  private clearFrame(): void {
    if (this.frameId !== null) this.env.cancelFrame(this.frameId);
    this.frameId = null;
  }
}

function focusVisible(target: EventTarget | null): boolean {
  try {
    return (target as Element).matches(':focus-visible');
  } catch {
    return true;
  }
}

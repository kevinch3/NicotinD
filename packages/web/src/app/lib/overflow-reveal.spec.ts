import { describe, expect, it, vi } from 'vitest';
import {
  OverflowReveal,
  REVEAL_ACTIVE_CLASS,
  REVEAL_EXPANDED_CLASS,
  REVEAL_PAUSE_MS,
  REVEAL_RETURN_SPEED_PX_S,
  REVEAL_SETTLE_MS,
  REVEAL_SPEED_PX_S,
  type OverflowRevealMode,
  type RevealEnv,
  type RevealInput,
} from './overflow-reveal';

const FRAME_MS = 16;

/**
 * A hand-driven clock, layout and observer set: jsdom has no layout, no
 * IntersectionObserver and no ResizeObserver, so every input the controller
 * reads is a knob here.
 */
function rig(
  opts: {
    mode?: OverflowRevealMode;
    input?: RevealInput;
    reducedMotion?: boolean;
    text?: string;
    overflow?: number;
    rtl?: boolean;
    title?: string;
    /** The name is itself the control (`<a appOverflowReveal routerLink>`). */
    hostIsControl?: boolean;
    /** A listener the host's template bound before the directive ran. */
    hostListener?: () => void;
  } = {},
) {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { due: number; cb: () => void }>();
  let frames = new Map<number, (t: number) => void>();
  let inViewCb: ((v: boolean, intersecting: boolean) => void) | null = null;
  let sizeCb: (() => void) | null = null;
  let textCb: (() => void) | null = null;
  const state = {
    input: opts.input ?? 'touch',
    reducedMotion: opts.reducedMotion ?? false,
    overflow: opts.overflow ?? 0,
    top: 100,
  };

  const row = document.createElement(opts.hostIsControl ? 'li' : 'button');
  const el = document.createElement(opts.hostIsControl ? 'button' : 'p');
  if (opts.hostListener) el.addEventListener('click', opts.hostListener);
  el.textContent = opts.text ?? 'A title long enough to overflow its row';
  if (opts.title) el.setAttribute('title', opts.title);
  if (opts.rtl) el.style.direction = 'rtl';
  row.appendChild(el);
  document.body.appendChild(row);
  let scrollLeft = 0;
  Object.defineProperty(el, 'clientWidth', { get: () => 200 });
  Object.defineProperty(el, 'scrollWidth', { get: () => 200 + state.overflow });
  Object.defineProperty(el, 'scrollLeft', {
    get: () => scrollLeft,
    set: (v: number) => (scrollLeft = v),
  });
  el.getBoundingClientRect = () => ({ top: state.top, left: 0 }) as DOMRect;

  const env: RevealEnv = {
    reducedMotion: () => state.reducedMotion,
    input: () => state.input,
    requestFrame: (cb) => (frames.set(++seq, cb), seq),
    cancelFrame: (id) => frames.delete(id),
    setTimer: (cb, ms) => (timers.set(++seq, { due: now + ms, cb }), seq),
    clearTimer: (id) => timers.delete(id),
    observeView: (_el, cb) => ((inViewCb = cb), () => (inViewCb = null)),
    observeSize: (_el, cb) => ((sizeCb = cb), () => (sizeCb = null)),
    observeText: (_el, cb) => ((textCb = cb), () => (textCb = null)),
  };

  const reveal = new OverflowReveal(el, opts.mode ?? 'list', env);

  /** Run the clock forward in frame-sized steps, firing timers then frames. */
  function advance(ms: number): number[] {
    const trace: number[] = [];
    for (const end = now + ms; now < end;) {
      now += FRAME_MS;
      for (const [id, t] of [...timers]) {
        if (t.due <= now) {
          timers.delete(id);
          t.cb();
        }
      }
      const due = frames;
      frames = new Map();
      for (const cb of due.values()) cb(now);
      trace.push(scrollLeft);
    }
    return trace;
  }

  return {
    el,
    row,
    reveal,
    state,
    advance,
    scrollLeft: () => scrollLeft,
    pending: () => timers.size + frames.size,
    view: (v: boolean, intersecting = v) => inViewCb?.(v, intersecting),
    resized: () => sizeCb?.(),
    textChanged: () => textCb?.(),
    observing: () => inViewCb !== null || sizeCb !== null || textCb !== null,
  };
}

const forwardMs = (px: number) => (px / REVEAL_SPEED_PX_S) * 1000;
const returnMs = (px: number) => (px / REVEAL_RETURN_SPEED_PX_S) * 1000;
/** One whole pass: lead pause, out, hold, back. */
const passMs = (px: number) => 2 * REVEAL_PAUSE_MS + forwardMs(px) + returnMs(px) + 4 * FRAME_MS;

describe('OverflowReveal', () => {
  describe('text that fits', () => {
    for (const mode of ['always', 'list'] as const) {
      for (const input of ['touch', 'pointer', 'tv'] as const) {
        it(`never moves (${mode}, ${input})`, () => {
          const r = rig({ mode, input, overflow: 0, text: 'I am 34' });
          r.view(true);
          r.row.dispatchEvent(new MouseEvent('mouseenter'));
          r.row.dispatchEvent(new FocusEvent('focusin'));
          const trace = r.advance(10_000);
          expect(Math.max(...trace)).toBe(0);
          expect(r.reveal.isAnimating()).toBe(false);
          expect(r.el.hasAttribute('title')).toBe(false);
        });
      }
    }
  });

  describe('always (the playing title)', () => {
    it('rests, scrolls the whole overflow at a constant speed, holds, returns, and loops', () => {
      const r = rig({ mode: 'always', overflow: 120 });
      r.view(true);
      const trace = r.advance(passMs(120));
      const ms = (frames: number) => frames * FRAME_MS;
      const firstMove = trace.findIndex((v) => v > 0);
      const firstEnd = trace.indexOf(120);
      const lastEnd = trace.lastIndexOf(120);
      expect(ms(firstMove)).toBeGreaterThanOrEqual(REVEAL_PAUSE_MS - FRAME_MS);
      expect(ms(firstMove)).toBeLessThanOrEqual(REVEAL_PAUSE_MS + 2 * FRAME_MS);
      expect(ms(firstEnd - firstMove)).toBeGreaterThanOrEqual(forwardMs(120) - 2 * FRAME_MS);
      expect(ms(firstEnd - firstMove)).toBeLessThanOrEqual(forwardMs(120) + 2 * FRAME_MS);
      expect(ms(lastEnd - firstEnd)).toBeGreaterThanOrEqual(REVEAL_PAUSE_MS - 2 * FRAME_MS);
      expect(ms(lastEnd - firstEnd)).toBeLessThanOrEqual(REVEAL_PAUSE_MS + 2 * FRAME_MS);
      // Monotonic out, monotonic back, home at the end.
      for (let i = 1; i <= firstEnd; i++) expect(trace[i]).toBeGreaterThanOrEqual(trace[i - 1]);
      for (let i = lastEnd + 1; i < trace.length; i++)
        expect(trace[i]).toBeLessThanOrEqual(trace[i - 1]);
      expect(trace.at(-1)).toBe(0);
      expect(r.el.classList.contains(REVEAL_ACTIVE_CLASS)).toBe(false);

      // And again, for as long as it is on screen.
      expect(Math.max(...r.advance(passMs(120)))).toBe(120);
      expect(r.reveal.isAnimating()).toBe(true);
    });

    it('clips instead of showing the ellipsis only while the text is off its start', () => {
      const r = rig({ mode: 'always', overflow: 120 });
      r.view(true);
      r.advance(REVEAL_PAUSE_MS - FRAME_MS);
      expect(r.el.classList.contains(REVEAL_ACTIVE_CLASS)).toBe(false);
      r.advance(1000);
      expect(r.el.classList.contains(REVEAL_ACTIVE_CLASS)).toBe(true);
    });

    it('takes longer for a longer title rather than going faster', () => {
      const short = rig({ mode: 'always', overflow: 80 });
      const long = rig({ mode: 'always', overflow: 800 });
      short.view(true);
      long.view(true);
      short.advance(REVEAL_PAUSE_MS + 500);
      long.advance(REVEAL_PAUSE_MS + 500);
      expect(Math.abs(short.scrollLeft() - long.scrollLeft())).toBeLessThanOrEqual(1);
    });

    it('does nothing off screen, and snaps to rest when it leaves mid-pass', () => {
      const r = rig({ mode: 'always', overflow: 120 });
      expect(Math.max(...r.advance(passMs(120)))).toBe(0);
      r.view(true);
      r.advance(REVEAL_PAUSE_MS + 1000);
      expect(r.scrollLeft()).toBeGreaterThan(0);
      r.view(false);
      expect(r.scrollLeft()).toBe(0);
      expect(r.pending()).toBe(0);
    });

    it('starts over from the beginning when the text changes mid-pass (a track change)', () => {
      const r = rig({ mode: 'always', overflow: 120 });
      r.view(true);
      r.advance(REVEAL_PAUSE_MS + 1500);
      expect(r.scrollLeft()).toBeGreaterThan(0);
      r.el.textContent = 'The next track, also too long to fit';
      r.textChanged();
      expect(r.scrollLeft()).toBe(0);
      expect(Math.max(...r.advance(REVEAL_PAUSE_MS - FRAME_MS))).toBe(0);
      r.advance(1000);
      expect(r.scrollLeft()).toBeGreaterThan(0);
    });

    it('stops when a resize makes the text fit', () => {
      const r = rig({ mode: 'always', overflow: 120 });
      r.view(true);
      r.advance(REVEAL_PAUSE_MS + 1000);
      r.state.overflow = 0;
      r.resized();
      expect(r.scrollLeft()).toBe(0);
      expect(Math.max(...r.advance(passMs(120)))).toBe(0);
    });

    it('scrolls the other way in a right-to-left name', () => {
      const r = rig({ mode: 'always', overflow: 60, rtl: true });
      r.view(true);
      r.advance(REVEAL_PAUSE_MS + forwardMs(60) + 2 * FRAME_MS);
      expect(r.scrollLeft()).toBe(-60);
    });
  });

  describe('list on touch', () => {
    it('plays one pass once the row has settled in view, then rests', () => {
      const r = rig({ overflow: 100 });
      r.view(true);
      expect(Math.max(...r.advance(REVEAL_SETTLE_MS + REVEAL_PAUSE_MS - FRAME_MS))).toBe(0);
      expect(Math.max(...r.advance(passMs(100)))).toBe(100);
      expect(r.scrollLeft()).toBe(0);
      expect(r.reveal.isAnimating()).toBe(false);
      expect(Math.max(...r.advance(4 * passMs(100)))).toBe(0);
      expect(r.pending()).toBe(0);
    });

    it('waits while the row is still moving (a scroll in flight)', () => {
      const r = rig({ overflow: 100 });
      r.view(true);
      for (let i = 0; i < 5; i++) {
        r.state.top -= 40;
        r.advance(REVEAL_SETTLE_MS);
      }
      expect(r.reveal.isAnimating()).toBe(false);
      r.advance(REVEAL_SETTLE_MS + REVEAL_PAUSE_MS + 1000);
      expect(r.scrollLeft()).toBeGreaterThan(0);
    });

    it('plays again after the row leaves view and settles back in', () => {
      const r = rig({ overflow: 100 });
      r.view(true);
      r.advance(REVEAL_SETTLE_MS + passMs(100));
      r.view(false);
      r.view(true);
      expect(Math.max(...r.advance(REVEAL_SETTLE_MS + passMs(100)))).toBe(100);
    });

    it('does not loop on a tap that focuses the row', () => {
      const r = rig({ overflow: 100 });
      r.view(true);
      // A tap focus is not :focus-visible.
      vi.spyOn(r.row, 'matches').mockReturnValue(false);
      r.row.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      r.advance(REVEAL_SETTLE_MS + passMs(100));
      expect(Math.max(...r.advance(2 * passMs(100)))).toBe(0);
    });
  });

  describe('list with a pointer (desktop)', () => {
    it('never plays on its own', () => {
      const r = rig({ input: 'pointer', overflow: 100 });
      r.view(true);
      expect(Math.max(...r.advance(3 * passMs(100)))).toBe(0);
    });

    it('scrolls while the row is hovered and returns home when the pointer leaves', () => {
      const r = rig({ input: 'pointer', overflow: 100 });
      r.view(true);
      r.row.dispatchEvent(new MouseEvent('mouseenter'));
      expect(Math.max(...r.advance(passMs(100)))).toBe(100);
      // Still hovered: it goes round again.
      r.advance(REVEAL_PAUSE_MS + 1000);
      expect(r.scrollLeft()).toBeGreaterThan(0);
      r.row.dispatchEvent(new MouseEvent('mouseleave'));
      r.advance(returnMs(100) + 4 * FRAME_MS);
      expect(r.scrollLeft()).toBe(0);
      expect(Math.max(...r.advance(2 * passMs(100)))).toBe(0);
    });

    it('scrolls while the row holds keyboard focus', () => {
      const r = rig({ input: 'pointer', overflow: 100 });
      r.view(true);
      const spy = vi.spyOn(r.row, 'matches').mockReturnValue(true);
      r.row.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(Math.max(...r.advance(passMs(100)))).toBe(100);
      r.row.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      r.advance(returnMs(100) + 4 * FRAME_MS);
      expect(Math.max(...r.advance(2 * passMs(100)))).toBe(0);
      spy.mockRestore();
    });
  });

  describe('list on TV', () => {
    it('ignores settling and plays only while D-pad focused', () => {
      const r = rig({ input: 'tv', overflow: 100 });
      r.view(true);
      expect(Math.max(...r.advance(2 * passMs(100)))).toBe(0);
      vi.spyOn(r.row, 'matches').mockReturnValue(true);
      r.row.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(Math.max(...r.advance(passMs(100)))).toBe(100);
    });
  });

  describe('prefers-reduced-motion', () => {
    for (const mode of ['always', 'list'] as const) {
      it(`never moves (${mode})`, () => {
        const r = rig({ mode, reducedMotion: true, overflow: 100, input: 'pointer' });
        r.view(true);
        r.row.dispatchEvent(new MouseEvent('mouseenter'));
        expect(Math.max(...r.advance(3 * passMs(100)))).toBe(0);
      });
    }

    it('expands to wrap on a tap, which the row underneath does not receive', () => {
      const r = rig({ reducedMotion: true, overflow: 100 });
      const rowTap = vi.fn();
      r.row.addEventListener('click', rowTap);
      r.view(true);
      r.el.click();
      expect(r.reveal.isExpanded()).toBe(true);
      expect(r.el.classList.contains(REVEAL_EXPANDED_CLASS)).toBe(true);
      expect(rowTap).not.toHaveBeenCalled();
      // Once the name is readable, the row behaves as it always did.
      r.el.click();
      expect(rowTap).toHaveBeenCalledTimes(1);
    });

    it('leaves a tap on a name that fits, or on a link inside the name, alone', () => {
      const fits = rig({ reducedMotion: true, overflow: 0 });
      const fitsTap = vi.fn();
      fits.row.addEventListener('click', fitsTap);
      fits.el.click();
      expect(fitsTap).toHaveBeenCalledTimes(1);
      expect(fits.reveal.isExpanded()).toBe(false);

      const r = rig({ reducedMotion: true, overflow: 100 });
      const link = document.createElement('a');
      link.href = '#';
      r.el.appendChild(link);
      const rowTap = vi.fn();
      r.row.addEventListener('click', rowTap);
      link.click();
      expect(rowTap).toHaveBeenCalledTimes(1);
      expect(r.reveal.isExpanded()).toBe(false);
    });

    it('stays wrapped when its own growth drops it under the in-view ratio at a viewport edge', () => {
      const r = rig({ reducedMotion: true, overflow: 100 });
      const rowTap = vi.fn();
      r.row.addEventListener('click', rowTap);
      r.view(true);
      r.el.click();
      // Wrapping made it taller than the space left above the edge: still on screen.
      r.view(false, true);
      expect(r.reveal.isExpanded()).toBe(true);
      r.el.click();
      expect(rowTap).toHaveBeenCalledTimes(1);
    });

    it('collapses once the name leaves the screen entirely, and the next visit wraps again', () => {
      const r = rig({ reducedMotion: true, overflow: 100 });
      const rowTap = vi.fn();
      r.row.addEventListener('click', rowTap);
      r.view(true);
      r.el.click();
      r.view(false, false);
      expect(r.reveal.isExpanded()).toBe(false);
      r.view(true);
      r.el.click();
      expect(r.reveal.isExpanded()).toBe(true);
      expect(rowTap).not.toHaveBeenCalled();
    });

    it('leaves a pointer click to the row, which has the title tooltip instead', () => {
      const r = rig({ reducedMotion: true, overflow: 100, input: 'pointer' });
      const rowTap = vi.fn();
      r.row.addEventListener('click', rowTap);
      r.view(true);
      r.el.click();
      expect(r.reveal.isExpanded()).toBe(false);
      expect(rowTap).toHaveBeenCalledTimes(1);
      expect(r.el.getAttribute('title')).toBe('A title long enough to overflow its row');
    });

    it('wraps on a D-pad select on TV, where there is no tooltip either', () => {
      const r = rig({ reducedMotion: true, overflow: 100, input: 'tv' });
      const rowTap = vi.fn();
      r.row.addEventListener('click', rowTap);
      r.view(true);
      r.el.click();
      expect(r.reveal.isExpanded()).toBe(true);
      expect(rowTap).not.toHaveBeenCalled();
    });

    it('takes the first tap before a host that is itself the control acts on it', () => {
      const act = vi.fn();
      const r = rig({ reducedMotion: true, overflow: 100, hostIsControl: true, hostListener: act });
      r.view(true);
      r.el.click();
      expect(r.reveal.isExpanded()).toBe(true);
      expect(act).not.toHaveBeenCalled();
      r.el.click();
      expect(act).toHaveBeenCalledTimes(1);
    });

    it('collapses again when the text changes', () => {
      const r = rig({ reducedMotion: true, overflow: 100 });
      r.el.click();
      r.textChanged();
      expect(r.el.classList.contains(REVEAL_EXPANDED_CLASS)).toBe(false);
    });

    it('does not swallow taps when motion is allowed', () => {
      const r = rig({ overflow: 100 });
      const rowTap = vi.fn();
      r.row.addEventListener('click', rowTap);
      r.el.click();
      expect(rowTap).toHaveBeenCalledTimes(1);
    });
  });

  describe('the full name for a pointer', () => {
    it('is the title while the name overflows, and goes when it fits', () => {
      const r = rig({ overflow: 100, text: '\n  Muriendo De Envidia\n    · Feat. Someone  ' });
      expect(r.el.getAttribute('title')).toBe('Muriendo De Envidia · Feat. Someone');
      r.state.overflow = 0;
      r.resized();
      expect(r.el.hasAttribute('title')).toBe(false);
    });

    it('follows a text change', () => {
      const r = rig({ overflow: 100, text: 'First' });
      r.el.textContent = 'Second';
      r.textChanged();
      expect(r.el.getAttribute('title')).toBe('Second');
    });

    it("never replaces the host's own title", () => {
      const r = rig({ overflow: 100, title: 'the full path' });
      r.resized();
      expect(r.el.getAttribute('title')).toBe('the full path');
    });
  });

  it('releases its observers, listeners and timers on destroy', () => {
    const r = rig({ input: 'pointer', overflow: 100 });
    r.view(true);
    r.row.dispatchEvent(new MouseEvent('mouseenter'));
    r.advance(REVEAL_PAUSE_MS + 500);
    r.reveal.destroy();
    expect(r.scrollLeft()).toBe(0);
    expect(r.pending()).toBe(0);
    expect(r.observing()).toBe(false);
    r.row.dispatchEvent(new MouseEvent('mouseenter'));
    expect(Math.max(...r.advance(passMs(100)))).toBe(0);
  });
});

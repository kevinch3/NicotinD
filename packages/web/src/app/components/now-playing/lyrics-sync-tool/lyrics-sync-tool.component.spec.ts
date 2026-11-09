import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { setInputValue } from '../../../../testing/signal-input';
import { haptic } from '../../../lib/haptics';
import {
  HOLD_COARSE_AFTER_MS,
  HOLD_DELAY_MS,
  HOLD_REPEAT_MS,
  LyricsSyncToolComponent,
  holdStepMs,
} from './lyrics-sync-tool.component';

vi.mock('../../../lib/haptics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/haptics')>()),
  haptic: vi.fn(),
}));

/** A pointer press on `id`, the way a finger starts a hold. */
function pressOn(el: HTMLElement, id: string): void {
  const btn = el.querySelector(`[data-testid="${id}"]`)!;
  btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
}
function releaseOn(el: HTMLElement, id: string): void {
  const btn = el.querySelector(`[data-testid="${id}"]`)!;
  btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}

describe('holdStepMs (#1656)', () => {
  it('moves a quarter second until the hold has lasted two seconds, then a whole one', () => {
    expect(holdStepMs(HOLD_DELAY_MS)).toBe(250);
    expect(holdStepMs(HOLD_COARSE_AFTER_MS - 1)).toBe(250);
    expect(holdStepMs(HOLD_COARSE_AFTER_MS)).toBe(1000);
  });
});

describe('LyricsSyncToolComponent (#1656)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make() {
    const fixture = TestBed.createComponent(LyricsSyncToolComponent);
    fixture.detectChanges();
    const steps: number[] = [];
    fixture.componentInstance.nudged.subscribe((ms) => steps.push(ms));
    return { fixture, el: fixture.nativeElement as HTMLElement, steps };
  }

  it('a press steps once at once, and a quick release adds nothing', () => {
    const { el, steps } = make();
    pressOn(el, 'lyrics-sync-later');
    releaseOn(el, 'lyrics-sync-later');
    vi.advanceTimersByTime(HOLD_DELAY_MS * 3);
    expect(steps).toEqual([250]);
  });

  it('a hold repeats every 100 ms after 400 ms, and stops on release', () => {
    const { el, steps } = make();
    pressOn(el, 'lyrics-sync-earlier');
    vi.advanceTimersByTime(HOLD_DELAY_MS + HOLD_REPEAT_MS * 3);
    expect(steps).toEqual([-250, -250, -250, -250]);
    releaseOn(el, 'lyrics-sync-earlier');
    vi.advanceTimersByTime(1000);
    expect(steps).toHaveLength(4);
  });

  it('a long hold speeds up to whole seconds', () => {
    const { el, steps } = make();
    pressOn(el, 'lyrics-sync-later');
    vi.advanceTimersByTime(HOLD_COARSE_AFTER_MS + HOLD_REPEAT_MS);
    releaseOn(el, 'lyrics-sync-later');
    expect(steps).toContain(250);
    expect(steps.at(-1)).toBe(1000);
  });

  it("a pointer tap's own click does not step a second time", () => {
    const { el, steps } = make();
    pressOn(el, 'lyrics-sync-later');
    releaseOn(el, 'lyrics-sync-later');
    const btn = el.querySelector('[data-testid="lyrics-sync-later"]')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(steps).toEqual([250]);
  });

  it('shows what the last tap did, then clears it', () => {
    const { fixture, el } = make();
    pressOn(el, 'lyrics-sync-later');
    releaseOn(el, 'lyrics-sync-later');
    fixture.detectChanges();
    const step = () => el.querySelector('[data-testid="lyrics-sync-step"]')!.textContent;
    expect(step()).toContain('nowPlaying.syncStepLater');
    vi.advanceTimersByTime(1500);
    fixture.detectChanges();
    expect(step()?.trim()).toBe('');
  });

  it('a destroyed tool stops repeating', () => {
    const { fixture, el, steps } = make();
    pressOn(el, 'lyrics-sync-later');
    fixture.destroy();
    vi.advanceTimersByTime(2000);
    expect(steps).toEqual([250]);
  });

  function at(offsetMs: number) {
    const fixture = TestBed.createComponent(LyricsSyncToolComponent);
    setInputValue(fixture.componentInstance.offsetMs, offsetMs);
    fixture.detectChanges();
    return fixture;
  }
  const q = (el: HTMLElement, id: string) =>
    el.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement;

  it('says the direction in words', () => {
    const value = (ms: number) => q(at(ms).nativeElement, 'lyrics-sync-value').textContent;
    expect(value(0)).toContain('nowPlaying.syncInSync');
    expect(value(1_500)).toContain('nowPlaying.syncValueLater');
    expect(value(-250)).toContain('nowPlaying.syncValueEarlier');
    expect(q(at(0).nativeElement, 'lyrics-sync-later').textContent).toContain(
      'nowPlaying.syncLaterShort',
    );
  });

  it('renders the same controls in the same order at any value, Reset disabled at zero', () => {
    // The first tap away from zero used to add Reset and move both buttons.
    const ids = (ms: number) =>
      Array.from(
        at(ms).nativeElement.querySelectorAll('[data-testid]') as NodeListOf<HTMLElement>,
      ).map((e) => e.dataset['testid']);
    expect(ids(250)).toEqual(ids(0));
    expect(ids(-12_500)).toEqual(ids(0));
    expect(q(at(0).nativeElement, 'lyrics-sync-reset').disabled).toBe(true);

    const fixture = at(1_000);
    let reset = false;
    fixture.componentInstance.reset.subscribe(() => (reset = true));
    q(fixture.nativeElement, 'lyrics-sync-reset').click();
    expect(reset).toBe(true);
  });

  it('a keyboard press steps, and each press ticks `select` (#1659)', () => {
    const { el, steps } = make();
    vi.mocked(haptic).mockClear();
    // Enter and Space dispatch a click with detail 0, which `.click()` does too.
    q(el, 'lyrics-sync-later').click();
    q(el, 'lyrics-sync-earlier').click();
    expect(steps).toEqual([250, -250]);
    expect(vi.mocked(haptic).mock.calls).toEqual([['select'], ['select']]);
  });

  it('keeps each surface its own test ids', () => {
    const fixture = TestBed.createComponent(LyricsSyncToolComponent);
    setInputValue(fixture.componentInstance.testid, 'karaoke-lyrics-sync');
    fixture.detectChanges();
    expect(q(fixture.nativeElement, 'karaoke-lyrics-sync-later')).toBeTruthy();
  });
});

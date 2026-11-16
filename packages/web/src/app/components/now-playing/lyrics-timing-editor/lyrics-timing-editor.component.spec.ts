import { TestBed } from '@angular/core/testing';
import { parseLrc } from '@nicotind/core';
import { setInputValue } from '../../../../testing/signal-input';
import type { TimingRow } from '../../../lib/lyrics-timing-draft';
import { LyricsTimingEditorComponent } from './lyrics-timing-editor.component';

const plain = (...texts: string[]): TimingRow[] => texts.map((text) => ({ text, timeMs: null }));

function make(initial: TimingRow[], opts: { playing?: boolean; positionMs?: number } = {}) {
  let now = 0;
  const fixture = TestBed.createComponent(LyricsTimingEditorComponent);
  const c = fixture.componentInstance;
  setInputValue(c.initial, initial);
  setInputValue(c.clock, () => now);
  setInputValue(c.playing, opts.playing ?? true);
  setInputValue(c.positionMs, opts.positionMs ?? 0);
  setInputValue(c.durationMs, 180_000);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(id: string) =>
    el.querySelector<T>(`[data-testid="${id}"]`)!;
  const all = (id: string) => Array.from(el.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));
  const press = (id: string) => {
    q(id).dispatchEvent(new Event('pointerdown', { bubbles: true }));
    fixture.detectChanges();
  };
  const click = (target: HTMLElement) => {
    target.click();
    fixture.detectChanges();
  };
  const seeks: number[] = [];
  let toggles = 0;
  c.seek.subscribe((ms) => seeks.push(ms));
  c.playToggled.subscribe(() => toggles++);
  return {
    fixture,
    c,
    q,
    all,
    press,
    click,
    seeks,
    toggles: () => toggles,
    at: (ms: number) => (now = ms),
    times: () => c.rows().map((r) => r.timeMs),
    targetRow: () => all('lyrics-timing-row').findIndex((r) => r.dataset['target'] === 'true'),
  };
}

describe('LyricsTimingEditorComponent (#1675)', () => {
  describe('stamping', () => {
    it("STAMP records the clock's time at pointerdown and moves the target to the next line", () => {
      const t = make(plain('one', 'two', 'three'));
      expect(t.targetRow()).toBe(0);
      t.at(1260);
      t.press('lyrics-timing-stamp');
      t.at(4500);
      t.press('lyrics-timing-stamp');
      expect(t.times()).toEqual([1260, 4500, null]);
      expect(t.targetRow()).toBe(2);
      expect(t.q('lyrics-timing-progress').textContent).toContain('lyricsTiming.progress');
    });

    it('does not stamp on a click alone, so one press is one stamp', () => {
      const t = make(plain('one', 'two'));
      t.at(1000);
      t.q('lyrics-timing-stamp').click();
      expect(t.times()).toEqual([null, null]);
    });

    it('Undo reverts the last stamp and puts the target back', () => {
      const t = make(plain('one', 'two'));
      t.at(1000);
      t.press('lyrics-timing-stamp');
      t.at(2000);
      t.press('lyrics-timing-stamp');
      t.click(t.q('lyrics-timing-undo'));
      expect(t.times()).toEqual([1000, null]);
      expect(t.targetRow()).toBe(1);
      t.click(t.q('lyrics-timing-undo'));
      expect(t.times()).toEqual([null, null]);
      expect(t.q<HTMLButtonElement>('lyrics-timing-undo').disabled).toBe(true);
    });

    it('disables STAMP once every line is stamped', () => {
      const t = make(plain('one'));
      t.at(1000);
      t.press('lyrics-timing-stamp');
      expect(t.q<HTMLButtonElement>('lyrics-timing-stamp').disabled).toBe(true);
    });

    it('tapping a line makes it the target, so a line can be stamped again', () => {
      const t = make([
        { text: 'one', timeMs: 1000 },
        { text: 'two', timeMs: 2000 },
      ]);
      t.click(t.all('lyrics-timing-text')[0]!);
      t.at(1500);
      t.press('lyrics-timing-stamp');
      expect(t.times()).toEqual([1500, 2000]);
    });
  });

  describe('retiming', () => {
    const timed = (): TimingRow[] => [
      { text: 'one', timeMs: 1000 },
      { text: 'two', timeMs: 2000 },
      { text: 'three', timeMs: 3000 },
    ];
    const openStepper = (t: ReturnType<typeof make>, row: number) =>
      t.click(t.all('lyrics-timing-time')[row]!);
    const step = (t: ReturnType<typeof make>, ms: number) =>
      t.click(t.q('lyrics-timing-stepper').querySelector<HTMLElement>(`[data-step="${ms}"]`)!);

    it('a nudge retimes one row', () => {
      const t = make(timed());
      openStepper(t, 1);
      step(t, 500);
      step(t, -100);
      expect(t.times()).toEqual([1000, 2400, 3000]);
    });

    it('"From here to the end" selects the tail, and a nudge then moves only that selection', () => {
      const t = make(timed());
      openStepper(t, 1);
      t.click(t.q('lyrics-timing-from-here'));
      expect(t.all('lyrics-timing-row').map((r) => r.dataset['selected'] ?? null)).toEqual([
        null,
        'true',
        'true',
      ]);
      step(t, 500);
      expect(t.times()).toEqual([1000, 2500, 3500]);
      t.click(t.q('lyrics-timing-selection-clear'));
      step(t, 100);
      expect(t.times()).toEqual([1000, 2600, 3500]);
    });

    it('with a selection in progress, tapping another line extends it to that line', () => {
      const t = make(timed());
      t.c.selection.set(new Set([0]));
      t.fixture.detectChanges();
      t.click(t.all('lyrics-timing-text')[2]!);
      expect([...t.c.selection()].sort()).toEqual([0, 1, 2]);
    });

    it('"Set to now" takes the clock, and "Play from here" seeks to 2 s before the line', () => {
      const t = make(timed(), { playing: false });
      openStepper(t, 2);
      t.at(7770);
      t.click(t.q('lyrics-timing-now'));
      expect(t.times()).toEqual([1000, 2000, 7770]);
      t.click(t.q('lyrics-timing-play-from'));
      expect(t.seeks).toEqual([5770]);
      expect(t.toggles()).toBe(1);
    });

    it('editing a line in place keeps its stamp', () => {
      const t = make(timed());
      openStepper(t, 0);
      t.click(t.q('lyrics-timing-edit-words'));
      const input = t.q<HTMLInputElement>('lyrics-timing-words');
      input.value = 'uno';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      t.fixture.detectChanges();
      expect(t.c.rows()[0]).toEqual({ text: 'uno', timeMs: 1000 });
    });
  });

  describe('saving', () => {
    it('Save stays disabled until every line has a stamp', () => {
      const t = make(plain('one', 'two'));
      const save = () => t.q<HTMLButtonElement>('lyrics-timing-save');
      expect(save().disabled).toBe(true);
      t.at(1000);
      t.press('lyrics-timing-stamp');
      expect(save().disabled).toBe(true);
      t.at(2000);
      t.press('lyrics-timing-stamp');
      expect(save().disabled).toBe(false);
    });

    it('emits the words and an LRC with the loaded offset already folded in', () => {
      // Loaded by `rowsFromLyrics` with a +250 ms offset applied.
      const t = make([
        { text: 'one', timeMs: 1250 },
        { text: 'two', timeMs: 5250 },
      ]);
      let body: { plain: string; synced: string } | null = null;
      t.c.saved.subscribe((b) => (body = b));
      t.click(t.q('lyrics-timing-save'));
      expect(body!.plain).toBe('one\ntwo');
      expect(parseLrc(body!.synced)).toEqual([
        { timeMs: 1250, text: 'one' },
        { timeMs: 5250, text: 'two' },
      ]);
    });

    it('Cancel and Escape close without saving', () => {
      const t = make(plain('one'));
      let cancelled = 0;
      let saved = 0;
      t.c.cancelled.subscribe(() => cancelled++);
      t.c.saved.subscribe(() => saved++);
      t.click(t.q('lyrics-timing-cancel'));
      (t.fixture.nativeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape' }),
      );
      expect(cancelled).toBe(2);
      expect(saved).toBe(0);
    });
  });

  describe('preview', () => {
    it('highlights the line playing at the playhead only while preview is on', () => {
      const rows: TimingRow[] = [
        { text: 'one', timeMs: 1000 },
        { text: 'two', timeMs: 5000 },
      ];
      const t = make(rows, { positionMs: 6000 });
      const active = () => t.all('lyrics-timing-row').findIndex((r) => r.dataset['active']);
      expect(active()).toBe(-1);
      t.click(t.q('lyrics-timing-preview'));
      expect(active()).toBe(1);
      expect(t.q('lyrics-timing-preview').getAttribute('aria-pressed')).toBe('true');
    });

    it('starts playback from the line being worked on', () => {
      const t = make(
        [
          { text: 'one', timeMs: 10_000 },
          { text: 'two', timeMs: null },
        ],
        { playing: false },
      );
      t.click(t.all('lyrics-timing-text')[0]!);
      t.click(t.q('lyrics-timing-preview'));
      expect(t.seeks).toEqual([8000]);
      expect(t.toggles()).toBe(1);
    });
  });

  it('skips two seconds either way from the clock', () => {
    const t = make(plain('one'));
    t.at(10_000);
    t.click(t.q('lyrics-timing-back'));
    t.click(t.q('lyrics-timing-forward'));
    t.at(500);
    t.click(t.q('lyrics-timing-back'));
    expect(t.seeks).toEqual([8000, 12_000, 0]);
  });
});

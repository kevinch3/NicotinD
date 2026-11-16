import { TestBed } from '@angular/core/testing';
import { setInputValue } from '../../../../testing/signal-input';
import { LyricsOptionsSheetComponent, type LyricsTryState } from './lyrics-options-sheet.component';

describe('LyricsOptionsSheetComponent (#1656)', () => {
  function make(opts: { source?: string | null; timed?: boolean; edited?: boolean } = {}) {
    const fixture = TestBed.createComponent(LyricsOptionsSheetComponent);
    setInputValue(fixture.componentInstance.source, opts.source ?? 'lrclib');
    setInputValue(fixture.componentInstance.timed, opts.timed ?? true);
    setInputValue(fixture.componentInstance.edited, opts.edited ?? false);
    fixture.detectChanges();
    return fixture;
  }
  const source = (f: ReturnType<typeof make>) =>
    (f.nativeElement as HTMLElement).querySelector('[data-testid="lyrics-options-source"]')!
      .textContent;

  it('names where the lyrics came from and whether they are timed', () => {
    expect(source(make())).toContain('LRCLIB');
    expect(source(make())).toContain('nowPlaying.lyricsTimed');
    expect(source(make({ source: 'file-tag', timed: false }))).toContain(
      'nowPlaying.lyricsFromFile',
    );
    expect(source(make({ source: 'file-tag', timed: false }))).toContain(
      'nowPlaying.lyricsUntimed',
    );
    expect(source(make({ source: 'user', edited: true }))).toContain(
      'nowPlaying.lyricsEditedByHand',
    );
  });

  it('offers the sync tool only for timed lyrics, which are the only ones it moves', () => {
    const q = (f: ReturnType<typeof make>) =>
      (f.nativeElement as HTMLElement).querySelector('app-lyrics-sync-tool');
    expect(q(make({ timed: true }))).not.toBeNull();
    expect(q(make({ timed: false }))).toBeNull();
  });

  it('closes from its close button and from Escape', () => {
    const fixture = make();
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('[data-testid="lyrics-options-close"]') as HTMLElement).click();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(closed).toBe(2);
  });

  describe('Try another source (#1674)', () => {
    const state = (over: Partial<LyricsTryState> = {}): LyricsTryState => ({
      walk: null,
      busy: false,
      result: null,
      ...over,
    });
    function withTry(tryState: LyricsTryState | null, edited = false) {
      const fixture = TestBed.createComponent(LyricsOptionsSheetComponent);
      setInputValue(fixture.componentInstance.source, 'lrclib');
      setInputValue(fixture.componentInstance.timed, true);
      setInputValue(fixture.componentInstance.edited, edited);
      setInputValue(fixture.componentInstance.tryState, tryState);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      const q = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      return { fixture, q };
    }

    it('is absent without a try state, which is the default and what TV gets', () => {
      expect(withTry(null).q('lyrics-try-another')).toBeNull();
    });

    it('emits on press, and is disabled with a spinner while busy', () => {
      const { fixture, q } = withTry(state());
      let presses = 0;
      fixture.componentInstance.tryAnother.subscribe(() => presses++);
      q('lyrics-try-another')!.click();
      expect(presses).toBe(1);

      const busy = withTry(state({ busy: true })).q('lyrics-try-another') as HTMLButtonElement;
      expect(busy.disabled).toBe(true);
      expect(busy.querySelector('.animate-spin')).not.toBeNull();
    });

    it('shows "n of m" on the source line once a walk wrote the row, not for an edit', () => {
      const walk = { index: 2, total: 7 };
      expect(withTry(state({ walk })).q('lyrics-options-position')?.textContent).toContain(
        'nowPlaying.lyricsPosition',
      );
      expect(withTry(state()).q('lyrics-options-position')).toBeNull();
      expect(withTry(state({ walk }), true).q('lyrics-options-position')).toBeNull();
    });

    it('offers "Undo last change" only while a previous version is kept (#1960)', () => {
      expect(withTry(state()).q('lyrics-undo')).toBeNull();
      const { fixture, q } = withTry(state({ canUndo: true }));
      let undos = 0;
      fixture.componentInstance.undo.subscribe(() => undos++);
      q('lyrics-undo')!.click();
      expect(undos).toBe(1);
      const busy = withTry(state({ canUndo: true, busy: true })).q('lyrics-undo');
      expect((busy as HTMLButtonElement).disabled).toBe(true);
    });

    it('reports each outcome in a status region', () => {
      const text = (kind: 'applied' | 'only-one' | 'no-match' | 'error') => {
        const applied =
          kind === 'applied'
            ? {
                source: 'lrclib',
                sourceTrackId: '7',
                candidateKey: '7',
                index: 2,
                total: 7,
                timed: true,
              }
            : null;
        const el = withTry(state({ result: { kind, applied } })).q('lyrics-try-result')!;
        expect(el.getAttribute('role')).toBe('status');
        return el.textContent!.trim();
      };
      expect(text('applied')).toBe('nowPlaying.lyricsTryApplied');
      expect(text('only-one')).toBe('nowPlaying.lyricsTryOnlyOne');
      expect(text('no-match')).toBe('nowPlaying.lyricsTryNone');
      expect(text('error')).toBe('nowPlaying.lyricsTryError');
    });
  });
});

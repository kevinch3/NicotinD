import { TestBed } from '@angular/core/testing';
import { setInputValue } from '../../../../testing/signal-input';
import { LyricsOptionsSheetComponent } from './lyrics-options-sheet.component';

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
});

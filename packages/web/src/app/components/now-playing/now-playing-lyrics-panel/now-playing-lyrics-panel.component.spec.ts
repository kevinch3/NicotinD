import { TestBed } from '@angular/core/testing';
import { NowPlayingLyricsPanelComponent } from './now-playing-lyrics-panel.component';
import { setInputValue } from '../../../../testing/signal-input';

describe('NowPlayingLyricsPanelComponent', () => {
  it('shows the empty state with a fetch button when there are no lyrics', () => {
    const fixture = TestBed.createComponent(NowPlayingLyricsPanelComponent);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="now-playing-lyrics-empty"]'),
    ).toBeTruthy();
  });

  it('emits fetchRequested when the fetch button is clicked', () => {
    const fixture = TestBed.createComponent(NowPlayingLyricsPanelComponent);
    fixture.detectChanges();
    let called = false;
    fixture.componentInstance.fetchRequested.subscribe(() => (called = true));
    fixture.nativeElement.querySelector('[data-testid="now-playing-lyrics-fetch"]').click();
    expect(called).toBe(true);
  });

  it('emits fullscreenRequested when the expand button is clicked', () => {
    const fixture = TestBed.createComponent(NowPlayingLyricsPanelComponent);
    setInputValue(fixture.componentInstance.lines, [{ text: 'la la' }]);
    fixture.detectChanges();
    let called = false;
    fixture.componentInstance.fullscreenRequested.subscribe(() => (called = true));
    fixture.nativeElement.querySelector('[data-testid="now-playing-karaoke-toggle"]').click();
    expect(called).toBe(true);
  });

  /**
   * The lyrics options (#1656). The sync tool sits behind one Options button,
   * hidden by default, because it permanently took space in a short viewport.
   * The sheet and the tool have their own specs: a child's signal inputs do
   * not bind under this harness (docs/web-ui.md).
   */
  describe('lyrics options', () => {
    function withLyrics(opts: { canSync?: boolean } = {}) {
      const fixture = TestBed.createComponent(NowPlayingLyricsPanelComponent);
      setInputValue(fixture.componentInstance.lines, [{ text: 'la la' }]);
      setInputValue(fixture.componentInstance.canSync, opts.canSync ?? true);
      fixture.detectChanges();
      return fixture;
    }
    const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`);

    it('is closed by default, and Options opens and closes the sheet', () => {
      const fixture = withLyrics();
      const el = fixture.nativeElement as HTMLElement;
      const toggle = q(el, 'lyrics-options-toggle') as HTMLElement;
      expect(q(el, 'lyrics-options-sheet')).toBeFalsy();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');

      toggle.click();
      fixture.detectChanges();
      expect(q(el, 'lyrics-options-sheet')).toBeTruthy();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');

      toggle.click();
      fixture.detectChanges();
      expect(q(el, 'lyrics-options-sheet')).toBeFalsy();
    });

    it('no longer keeps a sync row under the lyrics', () => {
      expect(q(withLyrics().nativeElement, 'lyrics-sync')).toBeFalsy();
    });

    it('is hidden, not disabled, for a viewer who cannot curate', () => {
      expect(q(withLyrics({ canSync: false }).nativeElement, 'lyrics-options-toggle')).toBeFalsy();
    });

    it('is not offered while there are no lyrics to set', () => {
      const fixture = TestBed.createComponent(NowPlayingLyricsPanelComponent);
      setInputValue(fixture.componentInstance.canSync, true);
      fixture.detectChanges();
      expect(q(fixture.nativeElement, 'lyrics-options-toggle')).toBeFalsy();
    });
  });
});

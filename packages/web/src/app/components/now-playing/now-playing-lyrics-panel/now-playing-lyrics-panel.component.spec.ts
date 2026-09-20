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
   * The sync nudge. Its placement is the feature: before this, the only lyrics
   * control lived in the empty state, so a listener looking at lyrics that were
   * plainly mistimed had nothing to press.
   */
  describe('sync nudge', () => {
    function withLyrics(opts: { canSync?: boolean; offsetMs?: number } = {}) {
      const fixture = TestBed.createComponent(NowPlayingLyricsPanelComponent);
      setInputValue(fixture.componentInstance.lines, [{ text: 'la la' }]);
      setInputValue(fixture.componentInstance.canSync, opts.canSync ?? true);
      setInputValue(fixture.componentInstance.offsetMs, opts.offsetMs ?? 0);
      fixture.detectChanges();
      return fixture;
    }

    it('appears beside the lyrics, not only in the empty state', () => {
      const el = withLyrics().nativeElement;
      expect(el.querySelector('[data-testid="lyrics-sync"]')).toBeTruthy();
      expect(el.querySelector('[data-testid="now-playing-lyrics-empty"]')).toBeFalsy();
    });

    it('is hidden — not disabled — for a viewer who cannot curate', () => {
      // A dead button invites a click that can only fail.
      const el = withLyrics({ canSync: false }).nativeElement;
      expect(el.querySelector('[data-testid="lyrics-sync"]')).toBeFalsy();
    });

    it('emits a signed step, letting the parent own the absolute value', () => {
      const fixture = withLyrics();
      const steps: number[] = [];
      fixture.componentInstance.offsetNudged.subscribe((ms) => steps.push(ms));
      fixture.nativeElement.querySelector('[data-testid="lyrics-sync-later"]').click();
      fixture.nativeElement.querySelector('[data-testid="lyrics-sync-earlier"]').click();
      expect(steps).toEqual([fixture.componentInstance.step, -fixture.componentInstance.step]);
    });

    it('reads "in sync" at zero and a signed value otherwise', () => {
      const zero = withLyrics({ offsetMs: 0 }).nativeElement;
      expect(zero.querySelector('[data-testid="lyrics-sync-value"]').textContent).toContain(
        'nowPlaying.syncInSync',
      );
      const later = withLyrics({ offsetMs: 1_500 }).nativeElement;
      expect(later.querySelector('[data-testid="lyrics-sync-value"]').textContent).toContain(
        '+1.50s',
      );
      const earlier = withLyrics({ offsetMs: -250 }).nativeElement;
      expect(earlier.querySelector('[data-testid="lyrics-sync-value"]').textContent).toContain(
        '0.25s',
      );
    });

    it('offers reset only once there is something to reset', () => {
      expect(
        withLyrics({ offsetMs: 0 }).nativeElement.querySelector(
          '[data-testid="lyrics-sync-reset"]',
        ),
      ).toBeFalsy();
      const fixture = withLyrics({ offsetMs: 1_000 });
      let reset = false;
      fixture.componentInstance.offsetReset.subscribe(() => (reset = true));
      fixture.nativeElement.querySelector('[data-testid="lyrics-sync-reset"]').click();
      expect(reset).toBe(true);
    });
  });
});

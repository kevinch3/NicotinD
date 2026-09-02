import { TestBed } from '@angular/core/testing';
import { NowPlayingKaraokeFullscreenComponent } from './now-playing-karaoke-fullscreen.component';
import { setInputValue } from '../../../../testing/signal-input';

describe('NowPlayingKaraokeFullscreenComponent', () => {
  it('emits exit when the close button is clicked', () => {
    const fixture = TestBed.createComponent(NowPlayingKaraokeFullscreenComponent);
    fixture.detectChanges();
    let called = false;
    fixture.componentInstance.exit.subscribe(() => (called = true));
    fixture.nativeElement.querySelector('[data-testid="karaoke-overlay"] button').click();
    expect(called).toBe(true);
  });

  it('emits lineSelected when a browse-mode line is clicked', () => {
    const fixture = TestBed.createComponent(NowPlayingKaraokeFullscreenComponent);
    setInputValue(fixture.componentInstance.browsing, true);
    setInputValue(fixture.componentInstance.lines, [{ text: 'la', timeMs: 0 }]);
    fixture.detectChanges();
    let selected: number | undefined;
    fixture.componentInstance.lineSelected.subscribe((i: number) => (selected = i));
    fixture.nativeElement.querySelector('[data-karaoke-line]').click();
    expect(selected).toBe(0);
  });

  it('emits vocalMuteToggle', () => {
    const fixture = TestBed.createComponent(NowPlayingKaraokeFullscreenComponent);
    fixture.detectChanges();
    let called = false;
    fixture.componentInstance.vocalMuteToggle.subscribe(() => (called = true));
    fixture.nativeElement.querySelector('[data-testid="vocal-mute-toggle"]').click();
    expect(called).toBe(true);
  });

  it('emits interaction on ArrowDown over the overlay', () => {
    const fixture = TestBed.createComponent(NowPlayingKaraokeFullscreenComponent);
    fixture.detectChanges();
    let called = false;
    fixture.componentInstance.interaction.subscribe(() => (called = true));
    const overlay = fixture.nativeElement.querySelector('[data-testid="karaoke-overlay"]');
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(called).toBe(true);
  });

  it('emits interaction on ArrowUp over the overlay', () => {
    const fixture = TestBed.createComponent(NowPlayingKaraokeFullscreenComponent);
    fixture.detectChanges();
    let called = false;
    fixture.componentInstance.interaction.subscribe(() => (called = true));
    const overlay = fixture.nativeElement.querySelector('[data-testid="karaoke-overlay"]');
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(called).toBe(true);
  });

  it('renders only current+next lines in auto-follow mode', () => {
    const fixture = TestBed.createComponent(NowPlayingKaraokeFullscreenComponent);
    setInputValue(fixture.componentInstance.browsing, false);
    setInputValue(fixture.componentInstance.currentLineText, 'b');
    setInputValue(fixture.componentInstance.nextLineText, 'c');
    setInputValue(fixture.componentInstance.lines, [
      { text: 'a', timeMs: 0 },
      { text: 'b', timeMs: 5000 },
      { text: 'c', timeMs: 10000 },
      { text: 'd', timeMs: 15000 },
    ]);
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const current = el.querySelector('[data-testid="karaoke-fullscreen-line-current"]');
    const next = el.querySelector('[data-testid="karaoke-fullscreen-line-next"]');
    expect(current?.textContent?.trim()).toBe('b');
    expect(next?.textContent?.trim()).toBe('c');
    expect(el.querySelectorAll('[data-karaoke-line]').length).toBe(2);
    expect(el.querySelector('[data-testid="karaoke-fullscreen-browse-list"]')).toBeNull();
  });

  // `lyricsScrollRef` (the `#lyricsScroll` viewChild on the browse-mode list
  // container, mirroring `NowPlayingLyricsPanelComponent.lyricsScrollRef`) is
  // not unit-testable here: this JIT vitest harness doesn't resolve
  // `viewChild()` queries at all — confirmed with a minimal inline-template
  // repro completely outside now-playing (a bare `<div #ref>` component's own
  // `viewChild<ElementRef>('ref')` also stays `undefined` after
  // `detectChanges()`), so this isn't specific to this component or a bug in
  // the fix. `overlayRef` above has the same, previously-unexamined gap — no
  // existing spec ever asserted it resolves either. The DOM contract this ref
  // targets (the browse-list container existing, keyed by testid, exactly
  // when `browsing()` is true) is covered by the test below; the ref's actual
  // resolution is exercised by e2e (real Chromium, no JIT harness).
  it('shows the full list in browse mode and emits lineSelected with the seek target', () => {
    const fixture = TestBed.createComponent(NowPlayingKaraokeFullscreenComponent);
    setInputValue(fixture.componentInstance.browsing, true);
    setInputValue(fixture.componentInstance.lines, [
      { text: 'a', timeMs: 0 },
      { text: 'b', timeMs: 5000 },
      { text: 'c', timeMs: 10000 },
    ]);
    fixture.detectChanges();

    const el: HTMLElement = fixture.nativeElement;
    const list = el.querySelector('[data-testid="karaoke-fullscreen-browse-list"]');
    expect(list).not.toBeNull();
    const lines = Array.from(el.querySelectorAll('[data-karaoke-line]'));
    expect(lines.length).toBe(3);

    let selected: number | undefined;
    fixture.componentInstance.lineSelected.subscribe((i: number) => (selected = i));
    (lines[2] as HTMLElement).click();

    expect(selected).toBe(2);
  });

  it('every overlay button is a D-pad nav item in a two-row group (issue #396)', () => {
    const fixture = TestBed.createComponent(NowPlayingKaraokeFullscreenComponent);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    // The overlay root is a vertical group holding two horizontal rows —
    // header (exit / browse / vocal-mute) and transport (prev / play / next).
    const overlay = el.querySelector('[data-testid="karaoke-overlay"]');
    expect(overlay?.hasAttribute('appTvNavGroup')).toBe(true);
    const rows = el.querySelectorAll('[data-testid="karaoke-overlay"] [appTvNavGroup]');
    expect(rows.length).toBe(2);
    const buttons = Array.from(el.querySelectorAll('button'));
    expect(buttons.length).toBe(6);
    for (const button of buttons) {
      expect(button.hasAttribute('appTvNavItem')).toBe(true);
    }
  });
});

describe('NowPlayingKaraokeFullscreenComponent — vocal mode (issue #603)', () => {
  // The unit harness renders i18n KEYS (no catalogue is loaded), so labels are
  // asserted by key; the numbers ride on data attributes.
  function make(
    mode: 'off' | 'pending' | 'ml' | 'basic',
    muted: boolean,
    eta: number | null = null,
    position: number | null = null,
  ) {
    const fixture = TestBed.createComponent(NowPlayingKaraokeFullscreenComponent);
    setInputValue(fixture.componentInstance.vocalMode, mode);
    setInputValue(fixture.componentInstance.vocalsMuted, muted);
    setInputValue(fixture.componentInstance.vocalEtaSec, eta);
    setInputValue(fixture.componentInstance.vocalQueuePosition, position);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }
  const button = (el: HTMLElement) =>
    el.querySelector('[data-testid="vocal-mute-toggle"]') as HTMLElement;
  const status = (el: HTMLElement) => el.querySelector('[data-testid="vocal-mute-status"]');

  it('shows no caption and the plain mute label when vocals are on', () => {
    const el = make('off', false);
    expect(status(el)).toBeNull();
    expect(button(el).getAttribute('aria-label')).toBe('nowPlaying.muteVocals');
    expect(button(el).getAttribute('data-vocal-mode')).toBe('off');
  });

  it('pending keeps the "unmute" label (toggling again cancels) and carries the ETA', () => {
    const el = make('pending', true, 42);
    expect(button(el).getAttribute('aria-label')).toBe('nowPlaying.unmuteVocals');
    expect(button(el).getAttribute('data-vocal-mode')).toBe('pending');
    expect(status(el)?.textContent).toContain('nowPlaying.vocalsPreparing');
    expect(status(el)?.getAttribute('data-eta')).toBe('42');
  });

  it('a queued stem shows its position', () => {
    const el = make('pending', true, 90, 2);
    expect(status(el)?.textContent).toContain('nowPlaying.vocalsQueued');
    expect(status(el)?.getAttribute('data-position')).toBe('2');
  });

  it('labels the served mode: ML instrumental vs basic center-cancel', () => {
    expect(status(make('ml', true))?.textContent).toContain('nowPlaying.vocalModeMl');
    expect(status(make('basic', true))?.textContent).toContain('nowPlaying.vocalModeBasic');
  });
});

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
});

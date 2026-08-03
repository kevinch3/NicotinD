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
});

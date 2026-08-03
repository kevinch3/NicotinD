import { TestBed } from '@angular/core/testing';
import { NowPlayingPanelTabsComponent } from './now-playing-panel-tabs.component';
import { setInputValue } from '../../../../testing/signal-input';

describe('NowPlayingPanelTabsComponent', () => {
  it('shows the queue count on the queue tab', () => {
    const fixture = TestBed.createComponent(NowPlayingPanelTabsComponent);
    setInputValue(fixture.componentInstance.queueCount, 4);
    fixture.detectChanges();
    const tab = fixture.nativeElement.querySelector('[data-testid="now-playing-tab-queue"]');
    expect(tab.textContent).toContain('4');
  });

  it('shows a lyrics-availability dot when hasLyrics is true', () => {
    const fixture = TestBed.createComponent(NowPlayingPanelTabsComponent);
    setInputValue(fixture.componentInstance.hasLyrics, true);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="now-playing-lyrics-dot"]'),
    ).toBeTruthy();
  });

  it('hides the dot when hasLyrics is false', () => {
    const fixture = TestBed.createComponent(NowPlayingPanelTabsComponent);
    setInputValue(fixture.componentInstance.hasLyrics, false);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="now-playing-lyrics-dot"]'),
    ).toBeNull();
  });

  it('emits panelSelected when the lyrics tab is clicked', () => {
    const fixture = TestBed.createComponent(NowPlayingPanelTabsComponent);
    fixture.detectChanges();
    let selected: string | undefined;
    fixture.componentInstance.panelSelected.subscribe((p: string) => (selected = p));
    fixture.nativeElement.querySelector('[data-testid="now-playing-tab-lyrics"]').click();
    expect(selected).toBe('lyrics');
  });

  it('marks the active tab aria-pressed', () => {
    const fixture = TestBed.createComponent(NowPlayingPanelTabsComponent);
    setInputValue(fixture.componentInstance.activePanel, 'lyrics');
    fixture.detectChanges();
    const lyricsTab = fixture.nativeElement.querySelector('[data-testid="now-playing-tab-lyrics"]');
    expect(lyricsTab.getAttribute('aria-pressed')).toBe('true');
  });

  it('hides the dot once the lyrics tab is already active', () => {
    const fixture = TestBed.createComponent(NowPlayingPanelTabsComponent);
    setInputValue(fixture.componentInstance.hasLyrics, true);
    setInputValue(fixture.componentInstance.activePanel, 'lyrics');
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="now-playing-lyrics-dot"]'),
    ).toBeNull();
  });
});

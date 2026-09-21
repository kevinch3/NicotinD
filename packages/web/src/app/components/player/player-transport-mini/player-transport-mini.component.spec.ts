import { TestBed } from '@angular/core/testing';
import { PlayerTransportMiniComponent } from './player-transport-mini.component';
import { setInputValue } from '../../../../testing/signal-input';

describe('PlayerTransportMiniComponent', () => {
  beforeEach(() => {
    // No PlayerService stub: the row is inputs and outputs only since shuffle
    // and repeat left the UI, and a stub for a dependency the component does
    // not have would hide a regression rather than catch one.
    TestBed.configureTestingModule({});
  });

  it('emits playPauseClicked when the play/pause button is clicked', () => {
    const fixture = TestBed.createComponent(PlayerTransportMiniComponent);
    fixture.detectChanges();
    let called = false;
    fixture.componentInstance.playPauseClicked.subscribe(() => (called = true));
    fixture.nativeElement.querySelector('[data-testid="player-playpause"]').click();
    expect(called).toBe(true);
  });

  it('shows the buffering spinner when buffering is true', () => {
    const fixture = TestBed.createComponent(PlayerTransportMiniComponent);
    setInputValue(fixture.componentInstance.buffering, true);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="player-playpause"] .animate-spin'),
    ).toBeTruthy();
  });

  it('emits prevClicked and nextClicked when their buttons are clicked', () => {
    const fixture = TestBed.createComponent(PlayerTransportMiniComponent);
    fixture.detectChanges();
    let prevCalled = false;
    let nextCalled = false;
    fixture.componentInstance.prevClicked.subscribe(() => (prevCalled = true));
    fixture.componentInstance.nextClicked.subscribe(() => (nextCalled = true));
    fixture.nativeElement.querySelector('[data-testid="player-prev"]').click();
    fixture.nativeElement.querySelector('[data-testid="player-next"]').click();
    expect(prevCalled).toBe(true);
    expect(nextCalled).toBe(true);
  });

  /**
   * Shuffle and repeat are gone from every player surface. Shuffle misled —
   * it reordered the queue you already had rather than starting a radio — and
   * repeat did neither: with radio on it neither repeated nor extended, which
   * is the confusion this removal ends.
   */
  it('renders prev, play and next, and nothing beside them', () => {
    const fixture = TestBed.createComponent(PlayerTransportMiniComponent);
    fixture.detectChanges();
    const ids = [...fixture.nativeElement.querySelectorAll('button')].map((b: HTMLElement) =>
      b.getAttribute('data-testid'),
    );
    expect(ids).toEqual(['player-prev', 'player-playpause', 'player-next']);
  });

  it('gives every icon-only control an accessible name', () => {
    const fixture = TestBed.createComponent(PlayerTransportMiniComponent);
    fixture.detectChanges();
    for (const btn of fixture.nativeElement.querySelectorAll('button')) {
      expect((btn as HTMLElement).getAttribute('aria-label')?.trim()).toBeTruthy();
    }
  });
});

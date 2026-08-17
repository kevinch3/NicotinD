import { TestBed } from '@angular/core/testing';
import { PlayerTransportMiniComponent } from './player-transport-mini.component';
import { PlayerService } from '../../../services/player.service';
import { setInputValue } from '../../../../testing/signal-input';

describe('PlayerTransportMiniComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PlayerService,
          useValue: {
            shuffle: () => false,
            repeat: () => 'off',
            toggleShuffle: vi.fn(),
            cycleRepeat: vi.fn(),
          },
        },
      ],
    });
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

  it('calls PlayerService.toggleShuffle and cycleRepeat directly on click', () => {
    const fixture = TestBed.createComponent(PlayerTransportMiniComponent);
    fixture.detectChanges();
    const player = TestBed.inject(PlayerService);
    fixture.nativeElement.querySelector('[data-testid="player-shuffle"]').click();
    expect(player.toggleShuffle).toHaveBeenCalled();
    fixture.nativeElement.querySelector('[data-testid="player-repeat"]').click();
    expect(player.cycleRepeat).toHaveBeenCalled();
  });

  it('renders active shuffle/repeat as a solid accent fill, never color alone (e-ink legibility)', () => {
    TestBed.overrideProvider(PlayerService, {
      useValue: {
        shuffle: () => true,
        repeat: () => 'all',
        toggleShuffle: vi.fn(),
        cycleRepeat: vi.fn(),
      },
    });
    const fixture = TestBed.createComponent(PlayerTransportMiniComponent);
    fixture.detectChanges();
    for (const id of ['player-shuffle', 'player-repeat']) {
      const el = fixture.nativeElement.querySelector(`[data-testid="${id}"]`) as HTMLElement;
      expect(el.className).toContain('bg-theme-accent');
      expect(el.className).toContain('text-theme-on-accent');
      expect(el.getAttribute('aria-pressed')).toBe('true');
      expect(el.getAttribute('data-active')).toBe('true');
    }
  });
});

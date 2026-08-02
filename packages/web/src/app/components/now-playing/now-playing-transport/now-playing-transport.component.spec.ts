import { TestBed } from '@angular/core/testing';
import { NowPlayingTransportComponent } from './now-playing-transport.component';
import { PlayerService } from '../../../services/player.service';
import { setInputValue } from '../../../../testing/signal-input';

describe('NowPlayingTransportComponent', () => {
  let toggleShuffle: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    toggleShuffle = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PlayerService,
          useValue: {
            shuffle: () => false,
            repeat: () => 'off',
            radio: () => false,
            toggleShuffle,
            cycleRepeat: vi.fn(),
            toggleRadio: vi.fn(),
          },
        },
      ],
    });
  });

  it('emits playPauseClicked on click', () => {
    const fixture = TestBed.createComponent(NowPlayingTransportComponent);
    fixture.detectChanges();
    let called = false;
    fixture.componentInstance.playPauseClicked.subscribe(() => (called = true));
    fixture.nativeElement.querySelector('[data-testid="now-playing-playpause"]').click();
    expect(called).toBe(true);
  });

  it('delegates shuffle toggle to PlayerService directly', () => {
    const fixture = TestBed.createComponent(NowPlayingTransportComponent);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('[data-testid="now-playing-shuffle"]').click();
    expect(toggleShuffle).toHaveBeenCalled();
  });

  it('formats progress/duration and reflects buffering state', () => {
    const fixture = TestBed.createComponent(NowPlayingTransportComponent);
    setInputValue(fixture.componentInstance.progress, 65);
    setInputValue(fixture.componentInstance.duration, 125);
    setInputValue(fixture.componentInstance.buffering, true);
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('1:05');
    expect(text).toContain('2:05');
    const playPause = fixture.nativeElement.querySelector('[data-testid="now-playing-playpause"]');
    expect(playPause.getAttribute('data-buffering')).toBe('true');
  });

  it('shows the autoplay-blocked banner and emits unblockAutoplay on click', () => {
    const fixture = TestBed.createComponent(NowPlayingTransportComponent);
    setInputValue(fixture.componentInstance.autoplayBlocked, true);
    fixture.detectChanges();
    let called = false;
    fixture.componentInstance.unblockAutoplay.subscribe(() => (called = true));
    const banner = fixture.nativeElement.querySelector('button');
    banner.click();
    expect(called).toBe(true);
  });

  it('emits nextClicked and prevClicked from the transport row', () => {
    const fixture = TestBed.createComponent(NowPlayingTransportComponent);
    fixture.detectChanges();
    let next = false;
    let prev = false;
    fixture.componentInstance.nextClicked.subscribe(() => (next = true));
    fixture.componentInstance.prevClicked.subscribe(() => (prev = true));
    // The transport row is [shuffle, prev, play/pause, next, repeat] — prev/next are the
    // two buttons without their own data-testid, positioned around the playpause button.
    const shuffle = fixture.nativeElement.querySelector('[data-testid="now-playing-shuffle"]');
    const row = shuffle.closest('div');
    const rowButtons: HTMLButtonElement[] = Array.from(row.querySelectorAll('button'));
    rowButtons[1].click(); // prev
    rowButtons[3].click(); // next
    expect(prev).toBe(true);
    expect(next).toBe(true);
  });

  it('delegates repeat and radio toggles to PlayerService directly', () => {
    const fixture = TestBed.createComponent(NowPlayingTransportComponent);
    fixture.detectChanges();
    const player = TestBed.inject(PlayerService) as unknown as {
      cycleRepeat: ReturnType<typeof vi.fn>;
      toggleRadio: ReturnType<typeof vi.fn>;
    };
    fixture.nativeElement.querySelector('[data-testid="now-playing-repeat"]').click();
    fixture.nativeElement.querySelector('[data-testid="now-playing-radio"]').click();
    expect(player.cycleRepeat).toHaveBeenCalled();
    expect(player.toggleRadio).toHaveBeenCalled();
  });
});

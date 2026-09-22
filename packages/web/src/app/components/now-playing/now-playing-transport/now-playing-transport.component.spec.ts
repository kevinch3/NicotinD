import { TestBed } from '@angular/core/testing';
import { NowPlayingTransportComponent } from './now-playing-transport.component';
import { PlayerService } from '../../../services/player.service';
import { setInputValue } from '../../../../testing/signal-input';
import { RecommendationsApiService } from '../../../services/api/recommendations-api.service';

describe('NowPlayingTransportComponent', () => {
  beforeEach(() => {
    // The stub is for the nested radio chip, not for this row: the transport
    // itself reads nothing off the player any more.
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PlayerService,
          useValue: {
            radio: () => false,
            radioFilter: () => null,
            radioStrategy: () => 'balanced',
            currentTrack: () => null,
            toggleRadio: vi.fn(),
            setRadioStrategy: vi.fn(),
          },
        },
        {
          provide: RecommendationsApiService,
          useValue: { feedback: vi.fn(), setPreferences: vi.fn() },
        },
      ],
    });
  });

  describe('on a TV build (tv-build root class)', () => {
    beforeEach(() => document.documentElement.classList.add('tv-build'));
    afterEach(() => document.documentElement.classList.remove('tv-build'));

    it('shows the same prev/play/next row the phone does', () => {
      const fixture = TestBed.createComponent(NowPlayingTransportComponent);
      fixture.detectChanges();
      const q = (id: string) => fixture.nativeElement.querySelector(`[data-testid="${id}"]`);
      expect(q('now-playing-shuffle')).toBeNull();
      expect(q('now-playing-repeat')).toBeNull();
      expect(q('now-playing-playpause')).not.toBeNull();
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

  /**
   * Shuffle and repeat are gone from every player surface. Shuffle reordered
   * the queue you already had rather than starting a radio, and repeat with
   * radio on neither repeated nor extended — a control whose only reliable
   * effect was confusion. The service state stays (`playNext` and the restored
   * session still read it); only the buttons are gone.
   */
  it('has no shuffle or repeat control on the phone either', () => {
    const fixture = TestBed.createComponent(NowPlayingTransportComponent);
    fixture.detectChanges();
    const q = (id: string) => fixture.nativeElement.querySelector(`[data-testid="${id}"]`);
    expect(q('now-playing-shuffle')).toBeNull();
    expect(q('now-playing-repeat')).toBeNull();
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

  it('emits nextClicked and prevClicked from the transport row', () => {
    const fixture = TestBed.createComponent(NowPlayingTransportComponent);
    fixture.detectChanges();
    let next = false;
    let prev = false;
    fixture.componentInstance.nextClicked.subscribe(() => (next = true));
    fixture.componentInstance.prevClicked.subscribe(() => (prev = true));
    // The row is [prev, play/pause, next] — prev/next are the two buttons
    // without their own data-testid, positioned around the playpause button.
    const playPause = fixture.nativeElement.querySelector(
      '[data-testid="now-playing-playpause"]',
    ) as HTMLElement;
    const row = playPause.closest('[appTvNavGroup]')!;
    const rowButtons: HTMLButtonElement[] = Array.from(row.querySelectorAll('button'));
    expect(rowButtons.length).toBe(3);
    rowButtons[0].click(); // prev
    rowButtons[2].click(); // next
    expect(prev).toBe(true);
    expect(next).toBe(true);
  });

  it('groups the transport row for D-pad nav with each control as a nav item', () => {
    // TV-nav coverage added by this extraction (issue: android-tv-support) — the transport row
    // previously had no appTvNavGroup/appTvNavItem wiring at all in now-playing.component.html;
    // this asserts the new coverage rather than treating it as inert relocated markup.
    const fixture = TestBed.createComponent(NowPlayingTransportComponent);
    fixture.detectChanges();
    const group = fixture.nativeElement.querySelector('[appTvNavGroup]');
    expect(group).toBeTruthy();
    const navItems = group.querySelectorAll('[appTvNavItem]');
    // prev, play/pause, next
    expect(navItems.length).toBe(3);
    expect(group.contains(navItems[0])).toBe(true);
  });

  // Every one of these is icon-only, so an absent name announces nothing at all.
  // Repeat shipped that way — `aria-pressed` with no label — until the Storybook
  // catalog's axe pass reached this transport through the Now Playing stories (#470).
  it('gives every icon-only transport control an accessible name', () => {
    const fixture = TestBed.createComponent(NowPlayingTransportComponent);
    fixture.detectChanges();
    const group = fixture.nativeElement.querySelector('[appTvNavGroup]');
    const buttons = Array.from<HTMLElement>(group.querySelectorAll('[appTvNavItem]'));
    expect(buttons.length).toBe(3);
    for (const button of buttons) {
      expect(button.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('delegates the radio toggle to PlayerService directly', () => {
    const fixture = TestBed.createComponent(NowPlayingTransportComponent);
    fixture.detectChanges();
    const player = TestBed.inject(PlayerService) as unknown as {
      toggleRadio: ReturnType<typeof vi.fn>;
    };
    fixture.nativeElement.querySelector('[data-testid="now-playing-radio"]').click();
    expect(player.toggleRadio).toHaveBeenCalled();
  });
});

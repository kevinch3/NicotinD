import { TestBed } from '@angular/core/testing';
import { NowPlayingTransportComponent } from './now-playing-transport.component';
import { PlayerService } from '../../../services/player.service';
import { setInputValue } from '../../../../testing/signal-input';
import { RecommendationsApiService } from '../../../services/api/recommendations-api.service';
import { LikeService } from '../../../services/like.service';
import { vi } from 'vitest';
import { haptic } from '../../../lib/haptics';

vi.mock('../../../lib/haptics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/haptics')>()),
  haptic: vi.fn(),
}));

describe('NowPlayingTransportComponent', () => {
  let current: { id: string } | null;
  let likes: { isLiked: ReturnType<typeof vi.fn>; toggle: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    current = null;
    likes = { isLiked: vi.fn().mockReturnValue(false), toggle: vi.fn() };
    // The radio fields are for the nested radio control; the row reads the
    // current track for its Like (layout B, #1716).
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PlayerService,
          useValue: {
            radio: () => false,
            radioFilter: () => null,
            radioStrategy: () => 'balanced',
            currentTrack: () => current,
            toggleRadio: vi.fn(),
            setRadioStrategy: vi.fn(),
          },
        },
        {
          provide: RecommendationsApiService,
          useValue: { feedback: vi.fn(), setPreferences: vi.fn() },
        },
        { provide: LikeService, useValue: likes },
      ],
    });
  });

  describe('layout B on a phone (#1715, #1716)', () => {
    it('Like leads the row and the radio control closes it', () => {
      current = { id: 't1' };
      const fixture = TestBed.createComponent(NowPlayingTransportComponent);
      fixture.detectChanges();
      const playPause = fixture.nativeElement.querySelector(
        '[data-testid="now-playing-playpause"]',
      ) as HTMLElement;
      const ids = Array.from(
        playPause.closest('[appTvNavGroup]')!.querySelectorAll('[data-testid]'),
      ).map((e) => e.getAttribute('data-testid'));
      expect(ids[0]).toBe('now-playing-like');
      expect(ids.at(-1)).toBe('now-playing-radio');
      // The radio chip row under the transport is gone on a phone.
      expect(fixture.nativeElement.querySelector('app-radio-chip')).toBeNull();
    });

    it('the transport Like toggles the current track and reports its state', () => {
      current = { id: 't1' };
      likes.isLiked.mockReturnValue(true);
      const fixture = TestBed.createComponent(NowPlayingTransportComponent);
      fixture.detectChanges();
      const heart = fixture.nativeElement.querySelector(
        '[data-testid="now-playing-like"]',
      ) as HTMLButtonElement;
      expect(heart.getAttribute('aria-pressed')).toBe('true');
      heart.click();
      expect(likes.toggle).toHaveBeenCalledWith('t1');
    });

    it('with radio off, the radio icon starts the radio in one tap', () => {
      const fixture = TestBed.createComponent(NowPlayingTransportComponent);
      fixture.detectChanges();
      const radio = fixture.nativeElement.querySelector(
        '[data-testid="now-playing-radio"]',
      ) as HTMLButtonElement;
      expect(radio.getAttribute('aria-pressed')).toBe('false');
      radio.click();
      expect(TestBed.inject(PlayerService).toggleRadio).toHaveBeenCalled();
    });

    it('renders no Like without a track', () => {
      const fixture = TestBed.createComponent(NowPlayingTransportComponent);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="now-playing-like"]')).toBeNull();
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

    it('keeps the radio chip and no Like: the pinned D-pad row is prev / play / next', () => {
      current = { id: 't1' };
      const fixture = TestBed.createComponent(NowPlayingTransportComponent);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('app-radio-chip')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="now-playing-like"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('app-np-radio-control')).toBeNull();
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
    fixture.nativeElement.querySelector('[data-testid="now-playing-prev"]').click();
    fixture.nativeElement.querySelector('[data-testid="now-playing-next"]').click();
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

  it('every transport press ticks `tap` (#1659)', () => {
    vi.mocked(haptic).mockClear();
    const fixture = TestBed.createComponent(NowPlayingTransportComponent);
    fixture.detectChanges();
    for (const id of ['now-playing-prev', 'now-playing-playpause', 'now-playing-next']) {
      fixture.nativeElement.querySelector(`[data-testid="${id}"]`).click();
    }
    expect(vi.mocked(haptic).mock.calls).toEqual([['tap'], ['tap'], ['tap']]);
  });
});

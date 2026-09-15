import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NowPlayingTransportComponent } from './now-playing-transport.component';
import { PlayerService } from '../../../services/player.service';
import { setInputValue } from '../../../../testing/signal-input';
import { RecommendationsApiService } from '../../../services/api/recommendations-api.service';
import BASE_CATALOG from '../../../../../public/i18n/en.json';

describe('NowPlayingTransportComponent', () => {
  let toggleShuffle: ReturnType<typeof vi.fn>;
  // A real signal, not a plain getter: the template reads it, so only a signal
  // write actually re-renders the label under this component's change detection.
  let repeatMode: WritableSignal<'off' | 'all' | 'one'>;

  beforeEach(() => {
    toggleShuffle = vi.fn();
    repeatMode = signal('off');
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PlayerService,
          useValue: {
            shuffle: () => false,
            repeat: repeatMode,
            radio: () => false,
            radioFilter: () => null,
            radioStrategy: () => 'balanced',
            currentTrack: () => null,
            toggleShuffle,
            cycleRepeat: vi.fn(),
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

    it('drops shuffle and repeat from the 10-foot transport, keeping prev/play/next', () => {
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

  it('groups the transport row for D-pad nav with each control as a nav item', () => {
    // TV-nav coverage added by this extraction (issue: android-tv-support) — the transport row
    // previously had no appTvNavGroup/appTvNavItem wiring at all in now-playing.component.html;
    // this asserts the new coverage rather than treating it as inert relocated markup.
    const fixture = TestBed.createComponent(NowPlayingTransportComponent);
    fixture.detectChanges();
    const group = fixture.nativeElement.querySelector('[appTvNavGroup]');
    expect(group).toBeTruthy();
    const navItems = group.querySelectorAll('[appTvNavItem]');
    // shuffle, prev, play/pause, next, repeat
    expect(navItems.length).toBe(5);
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
    expect(buttons.length).toBe(5);
    for (const button of buttons) {
      expect(button.getAttribute('aria-label')).toBeTruthy();
    }
  });

  // The name has to follow the mode, not just exist: a static label on a
  // three-state control is a wrong answer rather than a missing one.
  it('names the repeat control after the mode it is in', () => {
    const fixture = TestBed.createComponent(NowPlayingTransportComponent);
    fixture.detectChanges();
    const label = (): string | null =>
      fixture.nativeElement
        .querySelector('[data-testid="now-playing-repeat"]')
        .getAttribute('aria-label');
    // No catalog is loaded in a unit test, so `t` falls through to the key —
    // which is exactly what identifies the branch taken.
    expect(label()).toBe('nowPlaying.repeatOff');
    repeatMode.set('all');
    fixture.detectChanges();
    expect(label()).toBe('nowPlaying.repeatAll');
    repeatMode.set('one');
    fixture.detectChanges();
    expect(label()).toBe('nowPlaying.repeatOne');
    // And each of those keys is really in the base catalog. `t` falls through to
    // the raw key, so a typo would announce "nowPlaying.repeatOne" to a screen
    // reader and still satisfy every assertion above.
    expect(BASE_CATALOG).toHaveProperty(['nowPlaying.repeatOff']);
    expect(BASE_CATALOG).toHaveProperty(['nowPlaying.repeatAll']);
    expect(BASE_CATALOG).toHaveProperty(['nowPlaying.repeatOne']);
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

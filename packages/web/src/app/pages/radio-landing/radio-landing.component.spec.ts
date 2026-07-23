import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { RadioLandingComponent } from './radio-landing.component';
import { LibraryApiService } from '../../services/api/library-api.service';
import { ToastService } from '../../services/toast.service';
import { PlayerService, type Track } from '../../services/player.service';
import type { Song } from '../../services/api/api-types';

const SONG: Song = {
  id: 's1',
  title: 'Song 1',
  album: 'Album',
  albumId: 'a1',
  artist: 'Artist',
  artistId: 'ar1',
  coverArt: 'a1',
  size: 0,
  contentType: 'audio/mpeg',
  suffix: 'mp3',
  duration: 200,
  bitRate: 320,
  path: '/m/s1.mp3',
  created: '2024-01-01',
} as Song;

function setup(overrides: { getFilterRadio?: () => unknown; getGenres?: () => unknown } = {}) {
  const getFilterRadio = vi.fn(overrides.getFilterRadio ?? (() => of([SONG])));
  const getGenres = vi.fn(overrides.getGenres ?? (() => of([{ value: 'Rock' }, { value: 'Jazz' }])));
  const toastShow = vi.fn();

  TestBed.configureTestingModule({
    imports: [RadioLandingComponent],
    providers: [
      provideRouter([]),
      { provide: LibraryApiService, useValue: { getFilterRadio, getGenres } },
      { provide: ToastService, useValue: { show: toastShow } },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(RadioLandingComponent);
  const component = fixture.componentInstance;
  const player = TestBed.inject(PlayerService);
  fixture.detectChanges();
  return { fixture, component, player, getFilterRadio, toastShow };
}

describe('RadioLandingComponent', () => {
  it('hides the resume block when there is no last track', () => {
    const { component } = setup();
    expect(component.showResume()).toBe(false);
  });

  it('shows the resume block for a persisted track and hides it after tapping', () => {
    const { component, player } = setup();
    const track: Track = { id: 't1', title: 'Last', artist: 'A' };
    player.play(track);
    expect(component.showResume()).toBe(true);

    const startRadio = vi.spyOn(player, 'startRadio');
    component.onResume();
    expect(startRadio).toHaveBeenCalledWith(track);
    expect(component.showResume()).toBe(false);
  });

  it('starting a preset fetches filter radio and hands it to the player', async () => {
    const { component, player, getFilterRadio } = setup();
    const start = vi.spyOn(player, 'startRadioWithFilter');
    component.startPreset({ id: 'happy', label: 'Happy', emoji: '😊', filter: { moods: ['happy'] } });
    await Promise.resolve();
    expect(getFilterRadio).toHaveBeenCalledWith({ moods: ['happy'] }, [], 20);
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0][1]).toEqual({ moods: ['happy'] });
  });

  it('toasts and does not start radio when nothing matches', async () => {
    const { component, player, toastShow } = setup({ getFilterRadio: () => of([]) });
    const start = vi.spyOn(player, 'startRadioWithFilter');
    component.startGenre('Rock');
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    expect(toastShow).toHaveBeenCalled();
  });

  // Visual-contract assertions: pin chip hover utility classes so a refactor
  // can't silently regress the light-theme legibility (Daylight #6366f1 +
  // text-theme-on-accent ~ #ffffff ≈ 4.5:1 — borderline AA). The fix moves
  // hover to a tinted overlay + accent text so every theme reads cleanly.
  describe('visual contract', () => {
    it('preset chips use the accent-tinted hover (not a solid accent fill)', () => {
      const { fixture } = setup();
      const preset = fixture.nativeElement.querySelector(
        '[data-testid="radio-preset"]',
      ) as HTMLButtonElement;
      expect(preset).toBeTruthy();
      const cls = preset.className;
      expect(cls).toContain('hover:bg-theme-accent/15');
      expect(cls).toContain('hover:text-theme-accent');
      expect(cls).not.toContain('hover:bg-theme-accent ');
      expect(cls).not.toContain('hover:text-theme-on-accent');
    });

    it('genre chips match the preset-chip hover treatment', async () => {
      const { fixture } = setup();
      // ngOnInit fires loadGenres() which awaits firstValueFrom; let the
      // promise microtask settle so the @for renders the chips.
      await Promise.resolve();
      await Promise.resolve();
      fixture.detectChanges();
      const genre = fixture.nativeElement.querySelector(
        '[data-testid="radio-genre"]',
      ) as HTMLButtonElement;
      expect(genre).toBeTruthy();
      const cls = genre.className;
      expect(cls).toContain('hover:bg-theme-accent/15');
      expect(cls).toContain('hover:text-theme-accent');
      expect(cls).not.toContain('hover:bg-theme-accent ');
      expect(cls).not.toContain('hover:text-theme-on-accent');
    });
  });
});

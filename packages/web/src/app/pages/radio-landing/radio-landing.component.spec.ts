import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { RadioLandingComponent } from './radio-landing.component';
import { AuthService } from '../../services/auth.service';
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
  const getGenres = vi.fn(
    overrides.getGenres ?? (() => of([{ value: 'Rock' }, { value: 'Jazz' }])),
  );
  const toastShow = vi.fn();

  TestBed.configureTestingModule({
    imports: [RadioLandingComponent],
    providers: [
      provideRouter([]),
      // The nested shelves (Keep the vibe, Taste breakers) fetch on init, so the
      // stub must answer their calls too or the host spec dies on an unhandled
      // rejection rather than on its own assertions.
      {
        provide: LibraryApiService,
        useValue: {
          getFilterRadio,
          getGenres,
          getRandomSongs: () => of([]),
          getListRadio: () => of([]),
        },
      },
      { provide: ToastService, useValue: { show: toastShow } },
      { provide: AuthService, useValue: { token: signal('test-token') } },
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

  // Asserted on the method, not the child <app-cover-art>'s <img> — the JIT
  // vitest harness can't bind a child component's signal inputs.
  it('builds the standard /api/cover URL for the resume tile (the raw cover id 404s)', () => {
    const { component, player } = setup();
    player.play({ id: 't1', title: 'Last', artist: 'A', coverArt: 'cov9' });
    expect(component.resumeCoverSrc()).toBe('/api/cover/cov9?size=160&token=test-token');
  });

  it('resume tile has no cover URL when the last track carries no cover id', () => {
    const { component, player } = setup();
    player.play({ id: 't1', title: 'Last', artist: 'A' });
    expect(component.resumeCoverSrc()).toBeUndefined();
  });

  it('starting a preset fetches filter radio and hands it to the player', async () => {
    const { component, player, getFilterRadio } = setup();
    const start = vi.spyOn(player, 'startRadioWithFilter');
    component.startPreset({
      id: 'happy',
      label: 'Happy',
      emoji: '😊',
      gradient: 'from-amber-400 to-orange-500',
      filter: { moods: ['happy'] },
    });
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

  // The two tones (colored vibe / muted genre) are pinned in
  // vibe-tile.component.spec.ts, and the wiring that assigns them in
  // e2e/tests/radio-landing.spec.ts. Not here: the JIT vitest harness never
  // binds a nested component's signal inputs, so every <app-vibe-tile> in this
  // fixture renders its DEFAULTS — an assertion on its classes would pass or
  // fail on the default, never on what the template actually passes. The same
  // reasoning already governs the resume-cover test above.
  describe('start-a-radio block', () => {
    it('renders one tile per vibe preset', () => {
      const { fixture, component } = setup();
      const tiles = fixture.nativeElement.querySelectorAll('[data-testid="radio-preset"]');
      expect(tiles).toHaveLength(component.presets.length);
    });

    it('renders one tile per loaded genre', async () => {
      const { fixture } = setup();
      // ngOnInit fires loadGenres() which awaits firstValueFrom; let the
      // promise microtask settle so the @for renders the tiles.
      await Promise.resolve();
      await Promise.resolve();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelectorAll('[data-testid="radio-genre"]')).toHaveLength(2);
    });

    it('gives every preset a gradient, since the colored tone renders one', () => {
      const { component } = setup();
      for (const preset of component.presets) {
        expect(preset.gradient, `preset ${preset.id} has no gradient`).toMatch(/from-\S+ to-\S+/);
      }
    });
  });
});

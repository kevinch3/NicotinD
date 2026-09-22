import { TestBed, getTestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { RadioChipComponent } from './radio-chip.component';
import { PlayerService } from '../../../services/player.service';
import { RecommendationsApiService } from '../../../services/api/recommendations-api.service';
import { LibraryApiService } from '../../../services/api/library-api.service';
import { TranslateService } from '../../../services/translate.service';
import type { RadioProvenance, StrategyId } from '@nicotind/core';
import type { RadioAnchor } from '../../../services/player.service';

function setup(
  over: {
    radio?: boolean;
    strategy?: StrategyId;
    filter?: unknown;
    /** Defaults to a song radio anchored on `seed` (not the playing `s1`). */
    anchor?: RadioAnchor | null;
    provenance?: RadioProvenance | null;
  } = {},
) {
  const radioStrategy = signal<StrategyId>(over.strategy ?? 'balanced');
  const player = {
    radio: () => over.radio ?? true,
    radioFilter: () => over.filter ?? null,
    radioAnchor: () =>
      over.anchor === undefined ? { kind: 'song', id: 'seed', title: 'Seed Song' } : over.anchor,
    radioStrategy,
    currentTrack: () => ({ id: 's1', title: 'Toxic', artist: 'Britney' }),
    toggleRadio: vi.fn(),
    setRadioStrategy: vi.fn((s: StrategyId) => radioStrategy.set(s)),
  };
  const api = {
    feedback: vi.fn(() => of({ id: 1 })),
    setPreferences: vi.fn(() => of({ radioStrategy: 'balanced' })),
  };
  getTestBed().resetTestingModule();
  TestBed.configureTestingModule({
    imports: [RadioChipComponent],
    providers: [
      { provide: PlayerService, useValue: player },
      { provide: RecommendationsApiService, useValue: api },
      {
        provide: LibraryApiService,
        useValue: { radioProvenance: signal(over.provenance ?? null).asReadonly() },
      },
    ],
  });
  // The stub translator renders keys only, so params are asserted on the call.
  const t = vi.spyOn(TestBed.inject(TranslateService), 't');
  const fixture = TestBed.createComponent(RadioChipComponent);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const q = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { fixture, el, q, player, api, t };
}

describe('RadioChipComponent', () => {
  it('keeps the radio toggle contract and starts collapsed', () => {
    const { q, player, fixture } = setup();
    const main = q('now-playing-radio')!;
    expect(main.getAttribute('aria-pressed')).toBe('true');
    main.click();
    expect(player.toggleRadio).toHaveBeenCalled();
    expect(q('radio-chip-panel')).toBeNull();
    expect(q('radio-chip-expand')!.getAttribute('aria-expanded')).toBe('false');
    q('radio-chip-expand')!.click();
    fixture.detectChanges();
    expect(q('radio-chip-panel')).not.toBeNull();
    expect(q('radio-chip-expand')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('renders a radiogroup with the three positions, the current one checked', () => {
    const { q, fixture } = setup({ strategy: 'different' });
    q('radio-chip-expand')!.click();
    fixture.detectChanges();
    const group = q('radio-variety')!;
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(group.querySelectorAll('[role="radio"]')).toHaveLength(3);
    // `different` is the remedy for "too similar" — the inversion, pinned.
    expect(q('radio-variety-too-similar')!.getAttribute('aria-checked')).toBe('true');
    expect(q('radio-variety-balanced')!.getAttribute('aria-checked')).toBe('false');
  });

  it('a move steers the player, logs one vote against the playing track and saves the default', () => {
    const { q, fixture, player, api } = setup();
    q('radio-chip-expand')!.click();
    fixture.detectChanges();
    q('radio-variety-too-different')!.click();
    expect(player.setRadioStrategy).toHaveBeenCalledWith('similar');
    expect(api.feedback).toHaveBeenCalledTimes(1);
    // The vote names the anchor as the seed, never the playing track (#1277).
    expect(api.feedback).toHaveBeenCalledWith(
      's1',
      'too_different',
      expect.objectContaining({ strategyFrom: 'balanced', strategyTo: 'similar', seedId: 'seed' }),
    );
    expect(api.setPreferences).toHaveBeenCalledWith('similar');
    fixture.detectChanges();
    expect(q('radio-variety-too-different')!.getAttribute('aria-checked')).toBe('true');
  });

  it('a vote on a list radio carries the list, and on a station only the filter', () => {
    const list = setup({ anchor: { kind: 'list', ids: ['p1', 'p2'], members: ['p1', 'p2'] } });
    list.q('radio-chip-expand')!.click();
    list.fixture.detectChanges();
    list.q('radio-variety-too-similar')!.click();
    expect(list.api.feedback).toHaveBeenCalledWith(
      's1',
      'too_similar',
      expect.objectContaining({ seedIds: ['p1', 'p2'], seedId: undefined }),
    );

    const station = setup({ filter: { genres: ['Jazz'] } });
    station.q('radio-chip-expand')!.click();
    station.fixture.detectChanges();
    station.q('radio-variety-too-similar')!.click();
    expect(station.api.feedback).toHaveBeenCalledWith(
      's1',
      'too_similar',
      expect.objectContaining({
        filter: { genres: ['Jazz'] },
        seedId: undefined,
        seedIds: undefined,
      }),
    );
  });

  it('re-selecting the current position does nothing', () => {
    const { q, fixture, player, api } = setup();
    q('radio-chip-expand')!.click();
    fixture.detectChanges();
    q('radio-variety-balanced')!.click();
    expect(player.setRadioStrategy).not.toHaveBeenCalled();
    expect(api.feedback).not.toHaveBeenCalled();
  });

  it('describes the anchor or the station, and says so when radio is off', () => {
    const seeded = setup();
    seeded.q('radio-chip-expand')!.click();
    seeded.fixture.detectChanges();
    expect(seeded.q('radio-chip-description')!.textContent).toContain('nowPlaying.radioSeed');
    // The anchor's title, not the playing track's (#1277).
    expect(seeded.t).toHaveBeenCalledWith('nowPlaying.radioSeed', { title: 'Seed Song' });
    expect(seeded.t).not.toHaveBeenCalledWith('nowPlaying.radioSeed', { title: 'Toxic' });

    const listed = setup({ anchor: { kind: 'list', ids: ['p1'], members: ['p1'], name: 'Mix' } });
    listed.q('radio-chip-expand')!.click();
    listed.fixture.detectChanges();
    expect(listed.q('radio-chip-description')!.textContent).toContain('nowPlaying.radioList');
    expect(listed.t).toHaveBeenCalledWith('nowPlaying.radioList', { name: 'Mix' });

    const unanchored = setup({ anchor: null });
    unanchored.q('radio-chip-expand')!.click();
    unanchored.fixture.detectChanges();
    expect(unanchored.t).toHaveBeenCalledWith('nowPlaying.radioSeed', { title: 'Toxic' });

    const station = setup({ filter: { genres: ['Jazz'] } });
    station.q('radio-chip-expand')!.click();
    station.fixture.detectChanges();
    expect(station.q('radio-chip-description')!.textContent).toContain('nowPlaying.radioStation');

    const off = setup({ radio: false });
    off.q('radio-chip-expand')!.click();
    off.fixture.detectChanges();
    expect(off.q('radio-chip-description')!.textContent).toContain('nowPlaying.radioIdle');
  });

  it('omits the provenance line until a player-lane radio has reported one', () => {
    const { q, fixture } = setup();
    q('radio-chip-expand')!.click();
    fixture.detectChanges();
    // Null provenance means "this server did not tell us" — say nothing rather
    // than print a version we would be guessing.
    expect(q('radio-chip-provenance')).toBeNull();
  });

  it('reports the formula, the strategy and the genre axis that actually ran', () => {
    const { q, fixture } = setup({
      provenance: { formulaVersion: 8, genreAxis: 'learned', strategy: 'balanced', lane: 'seed' },
    });
    q('radio-chip-expand')!.click();
    fixture.detectChanges();
    const text = q('radio-chip-provenance')!.textContent!;
    expect(text).toContain('nowPlaying.radioFormula');
    expect(text).toContain('nowPlaying.radioStrategy.balanced');
    expect(text).toContain('nowPlaying.radioAxis.learned');
  });

  it('distinguishes a station from a lexical genre axis', () => {
    const { q, fixture } = setup({
      filter: { genres: ['Jazz'] },
      provenance: {
        formulaVersion: 8,
        genreAxis: 'station',
        strategy: 'different',
        lane: 'filter',
      },
    });
    q('radio-chip-expand')!.click();
    fixture.detectChanges();
    expect(q('radio-chip-provenance')!.textContent).toContain('nowPlaying.radioAxis.station');
  });

  it('arrow keys move the position; Escape collapses', () => {
    const { q, fixture, player } = setup();
    q('radio-chip-expand')!.click();
    fixture.detectChanges();
    const group = q('radio-variety')!;
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(player.setRadioStrategy).toHaveBeenCalledWith('similar');
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(q('radio-chip-panel')).toBeNull();
  });
});

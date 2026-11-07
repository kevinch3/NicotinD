import { TestBed, getTestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { RadioChipComponent } from './radio-chip.component';
import { PlayerService } from '../../../services/player.service';
import { RecommendationsApiService } from '../../../services/api/recommendations-api.service';
import { LibraryApiService } from '../../../services/api/library-api.service';
import { TranslateService } from '../../../services/translate.service';
import { STRATEGY_IDS, VARIETIES, varietyForStrategy } from '@nicotind/core';
import type { RadioProvenance, StrategyId } from '@nicotind/core';
import type { RadioAnchor } from '../../../services/player.service';
import EN from '../../../../../public/i18n/en.json';
import ES from '../../../../../public/i18n/es.json';

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
    const { q, fixture } = setup({ strategy: 'similar' });
    q('radio-chip-expand')!.click();
    fixture.detectChanges();
    const group = q('radio-variety')!;
    expect(group.getAttribute('role')).toBe('radiogroup');
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    // Left to right is a dial from closer to farther (#1660).
    expect(radios.map((r) => r.dataset['testid'])).toEqual([
      'radio-variety-close',
      'radio-variety-medium',
      'radio-variety-far',
    ]);
    // `similar` is the closest strategy, so it lights Close.
    expect(q('radio-variety-close')!.getAttribute('aria-checked')).toBe('true');
    expect(q('radio-variety-medium')!.getAttribute('aria-checked')).toBe('false');
    expect(q('radio-variety-far')!.getAttribute('aria-checked')).toBe('false');
  });

  it('the rightmost segment applies different, logs one vote and saves the default', () => {
    const { q, fixture, player, api } = setup();
    q('radio-chip-expand')!.click();
    fixture.detectChanges();
    q('radio-variety-far')!.click();
    expect(player.setRadioStrategy).toHaveBeenCalledWith('different');
    expect(api.feedback).toHaveBeenCalledTimes(1);
    // The vote names the anchor as the seed, never the playing track (#1277);
    // its kind follows the target strategy, unchanged on the wire.
    expect(api.feedback).toHaveBeenCalledWith(
      's1',
      'too_similar',
      expect.objectContaining({
        strategyFrom: 'balanced',
        strategyTo: 'different',
        seedId: 'seed',
      }),
    );
    expect(api.setPreferences).toHaveBeenCalledWith('different');
    fixture.detectChanges();
    expect(q('radio-variety-far')!.getAttribute('aria-checked')).toBe('true');
  });

  it('the leftmost segment applies similar and logs too_different', () => {
    const { q, fixture, player, api } = setup();
    q('radio-chip-expand')!.click();
    fixture.detectChanges();
    q('radio-variety-close')!.click();
    expect(player.setRadioStrategy).toHaveBeenCalledWith('similar');
    expect(api.feedback).toHaveBeenCalledWith(
      's1',
      'too_different',
      expect.objectContaining({ strategyFrom: 'balanced', strategyTo: 'similar' }),
    );
  });

  it.each(STRATEGY_IDS)(
    'the lit segment, the footer and the applied strategy are one concept (%s)',
    (s) => {
      const { el, q, fixture } = setup({
        strategy: s,
        provenance: { formulaVersion: 9, genreAxis: 'learned', strategy: s, lane: 'seed' },
      });
      q('radio-chip-expand')!.click();
      fixture.detectChanges();
      const lit = el.querySelectorAll<HTMLElement>('[role="radio"][aria-checked="true"]');
      expect(lit).toHaveLength(1);
      const label = lit[0]!.textContent!.trim();
      expect(label).not.toBe('');
      // The stub translator renders keys, so equal text means one shared key.
      expect(q('radio-chip-provenance')!.textContent).toContain(label);
      expect(lit[0]!.dataset['testid']).toBe(`radio-variety-${varietyForStrategy(s)}`);
    },
  );

  it('both catalogs name the dial Close · Medium · Far and the hint uses the same words', () => {
    const { fixture } = setup();
    const keys = VARIETIES.map((v) => fixture.componentInstance.labelKey(v));
    expect(keys).toEqual([
      'nowPlaying.varietyClose',
      'nowPlaying.varietyMedium',
      'nowPlaying.varietyFar',
    ]);
    for (const catalog of [EN, ES] as Array<Record<string, string>>) {
      const labels = keys.map((k) => catalog[k]);
      for (const l of labels) expect(typeof l === 'string' && l.length > 0).toBe(true);
      expect(new Set(labels).size).toBe(3);
      const hint = catalog['nowPlaying.varietyHint']!.toLowerCase();
      // The hint lists the three words in dial order, not just somewhere in a
      // sentence ("how far" alone would satisfy a bare substring check).
      expect(hint).toContain(`${labels[0]!.toLowerCase()}, ${labels[1]!.toLowerCase()} `);
      expect(hint).toMatch(new RegExp(`\\b${labels[2]!.toLowerCase()}\\.`));
      const stale = Object.keys(catalog).filter(
        (k) =>
          k === 'nowPlaying.varietyTooSimilar' ||
          k === 'nowPlaying.varietyBalanced' ||
          k === 'nowPlaying.varietyTooDifferent' ||
          k.startsWith('nowPlaying.radioStrategy.'),
      );
      expect(stale).toEqual([]);
    }
    expect(EN['nowPlaying.varietyClose' as keyof typeof EN]).toBe('Close');
    expect(ES['nowPlaying.varietyFar' as keyof typeof ES]).toBe('Lejos');
  });

  it('a vote on a list radio carries the list, and on a station only the filter', () => {
    const list = setup({ anchor: { kind: 'list', ids: ['p1', 'p2'], members: ['p1', 'p2'] } });
    list.q('radio-chip-expand')!.click();
    list.fixture.detectChanges();
    list.q('radio-variety-far')!.click();
    expect(list.api.feedback).toHaveBeenCalledWith(
      's1',
      'too_similar',
      expect.objectContaining({ seedIds: ['p1', 'p2'], seedId: undefined }),
    );

    const station = setup({ filter: { genres: ['Jazz'] } });
    station.q('radio-chip-expand')!.click();
    station.fixture.detectChanges();
    station.q('radio-variety-far')!.click();
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
    q('radio-variety-medium')!.click();
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
    expect(text).toContain('nowPlaying.varietyMedium');
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

  it('ArrowRight moves toward farther, ArrowLeft toward closer; Escape collapses', () => {
    const { q, fixture, player } = setup();
    q('radio-chip-expand')!.click();
    fixture.detectChanges();
    const group = q('radio-variety')!;
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(player.setRadioStrategy).toHaveBeenLastCalledWith('different');
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(player.setRadioStrategy).toHaveBeenLastCalledWith('balanced');
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(q('radio-chip-panel')).toBeNull();
  });
});

import { TestBed, getTestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { RadioChipComponent } from './radio-chip.component';
import { PlayerService } from '../../../services/player.service';
import { RecommendationsApiService } from '../../../services/api/recommendations-api.service';
import type { StrategyId } from '@nicotind/core';

function setup(over: { radio?: boolean; strategy?: StrategyId; filter?: unknown } = {}) {
  const radioStrategy = signal<StrategyId>(over.strategy ?? 'balanced');
  const player = {
    radio: () => over.radio ?? true,
    radioFilter: () => over.filter ?? null,
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
    ],
  });
  const fixture = TestBed.createComponent(RadioChipComponent);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const q = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { fixture, el, q, player, api };
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
    expect(api.feedback).toHaveBeenCalledWith(
      's1',
      'too_different',
      expect.objectContaining({ strategyFrom: 'balanced', strategyTo: 'similar', seedId: 's1' }),
    );
    expect(api.setPreferences).toHaveBeenCalledWith('similar');
    fixture.detectChanges();
    expect(q('radio-variety-too-different')!.getAttribute('aria-checked')).toBe('true');
  });

  it('re-selecting the current position does nothing', () => {
    const { q, fixture, player, api } = setup();
    q('radio-chip-expand')!.click();
    fixture.detectChanges();
    q('radio-variety-balanced')!.click();
    expect(player.setRadioStrategy).not.toHaveBeenCalled();
    expect(api.feedback).not.toHaveBeenCalled();
  });

  it('describes the seed or the station, and says so when radio is off', () => {
    const seeded = setup();
    seeded.q('radio-chip-expand')!.click();
    seeded.fixture.detectChanges();
    expect(seeded.q('radio-chip-description')!.textContent).toContain('nowPlaying.radioSeed');

    const station = setup({ filter: { genres: ['Jazz'] } });
    station.q('radio-chip-expand')!.click();
    station.fixture.detectChanges();
    expect(station.q('radio-chip-description')!.textContent).toContain('nowPlaying.radioStation');

    const off = setup({ radio: false });
    off.q('radio-chip-expand')!.click();
    off.fixture.detectChanges();
    expect(off.q('radio-chip-description')!.textContent).toContain('nowPlaying.radioIdle');
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

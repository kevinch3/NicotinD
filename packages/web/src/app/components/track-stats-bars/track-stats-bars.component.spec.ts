import { ɵSIGNAL as SIGNAL } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrackStatsBarsComponent } from './track-stats-bars.component';

/**
 * The web JIT vitest harness has no compile-time transform for Angular's
 * signal input() API, so we write straight to the node behind ɵSIGNAL
 * before the fixture's first detectChanges(). Same pattern as
 * seek-bar.component.spec.ts and track-row.component.spec.ts.
 */
function setInputValue<T>(inputSignal: () => T, value: T): void {
  (inputSignal as unknown as Record<typeof SIGNAL, { value: T }>)[SIGNAL].value = value;
}

describe('TrackStatsBarsComponent — badges', () => {
  function setup(overrides: {
    bpm?: number | null;
    genre?: string | null;
    key?: string | null;
    mood?: string | null;
  } = {}) {
    TestBed.configureTestingModule({ imports: [TrackStatsBarsComponent] });
    const fixture = TestBed.createComponent(TrackStatsBarsComponent);
    if (overrides.bpm !== undefined) setInputValue(fixture.componentInstance.bpm, overrides.bpm);
    if (overrides.genre !== undefined) setInputValue(fixture.componentInstance.genre, overrides.genre);
    if (overrides.key !== undefined) setInputValue(fixture.componentInstance.key, overrides.key);
    if (overrides.mood !== undefined) setInputValue(fixture.componentInstance.mood, overrides.mood);
    fixture.detectChanges();
    return fixture;
  }

  it('renders no badges when all inputs are null', () => {
    const fixture = setup({ bpm: null, genre: null, key: null, mood: null });
    const badges = fixture.nativeElement.querySelectorAll('.badge');
    expect(badges.length).toBe(0);
  });

  it('renders a BPM badge when bpm is provided', () => {
    const fixture = setup({ bpm: 126 });
    const badge = fixture.nativeElement.querySelector('[data-testid="badge-bpm"]');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain('126');
  });

  it('rounds BPM to the nearest integer', () => {
    const fixture = setup({ bpm: 125.7 });
    const badge = fixture.nativeElement.querySelector('[data-testid="badge-bpm"]');
    expect(badge.textContent).toContain('126');
  });

  it('renders a Genre badge when genre is provided', () => {
    const fixture = setup({ genre: 'Breakbeat' });
    const badge = fixture.nativeElement.querySelector('[data-testid="badge-genre"]');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain('Breakbeat');
  });

  it('renders a Key badge when key is provided', () => {
    const fixture = setup({ key: 'C major' });
    const badge = fixture.nativeElement.querySelector('[data-testid="badge-key"]');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain('C major');
  });

  it('renders a Mood badge with capitalized value', () => {
    const fixture = setup({ mood: 'party' });
    const badge = fixture.nativeElement.querySelector('[data-testid="badge-mood"]');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain('Party');
  });

  it('renders all four badges when all inputs are provided', () => {
    const fixture = setup({ bpm: 128, genre: 'House', key: 'A minor', mood: 'happy' });
    const badges = fixture.nativeElement.querySelectorAll('.badge');
    expect(badges.length).toBe(4);
  });
});

describe('TrackStatsBarsComponent — bars', () => {
  function setup(overrides: {
    energy?: number | null;
    valence?: number | null;
    danceability?: number | null;
    acousticness?: number | null;
    instrumental?: number | null;
  } = {}) {
    TestBed.configureTestingModule({ imports: [TrackStatsBarsComponent] });
    const fixture = TestBed.createComponent(TrackStatsBarsComponent);
    if (overrides.energy !== undefined) setInputValue(fixture.componentInstance.energy, overrides.energy);
    if (overrides.valence !== undefined) setInputValue(fixture.componentInstance.valence, overrides.valence);
    if (overrides.danceability !== undefined) setInputValue(fixture.componentInstance.danceability, overrides.danceability);
    if (overrides.acousticness !== undefined) setInputValue(fixture.componentInstance.acousticness, overrides.acousticness);
    if (overrides.instrumental !== undefined) setInputValue(fixture.componentInstance.instrumental, overrides.instrumental);
    fixture.detectChanges();
    return fixture;
  }

  it('renders no bars when all metric inputs are null', () => {
    const fixture = setup({
      energy: null,
      valence: null,
      danceability: null,
      acousticness: null,
      instrumental: null,
    });
    const bars = fixture.nativeElement.querySelectorAll('.bar-item');
    expect(bars.length).toBe(0);
  });

  it('renders one bar when only energy is provided', () => {
    const fixture = setup({ energy: 0.55 });
    const bars = fixture.nativeElement.querySelectorAll('.bar-item');
    expect(bars.length).toBe(1);
  });

  it('renders all five bars when all metrics are provided', () => {
    const fixture = setup({
      energy: 0.55,
      valence: 0.61,
      danceability: 0.99,
      acousticness: 0.02,
      instrumental: 0.72,
    });
    const bars = fixture.nativeElement.querySelectorAll('.bar-item');
    expect(bars.length).toBe(5);
  });

  it('converts 0..1 values to 0..100 percentages', () => {
    const fixture = setup({ energy: 0.55, danceability: 0.99 });
    const energyBar = fixture.nativeElement.querySelector('[data-testid="bar-energy"]');
    const danceBar = fixture.nativeElement.querySelector('[data-testid="bar-dance"]');
    expect(energyBar.querySelector('.bar-value').textContent.trim()).toBe('55%');
    expect(danceBar.querySelector('.bar-value').textContent.trim()).toBe('99%');
  });

  it('rounds percentage values correctly', () => {
    const fixture = setup({ energy: 0.556, valence: 0.614 });
    const energyBar = fixture.nativeElement.querySelector('[data-testid="bar-energy"]');
    const valenceBar = fixture.nativeElement.querySelector('[data-testid="bar-valence"]');
    expect(energyBar.querySelector('.bar-value').textContent.trim()).toBe('56%');
    expect(valenceBar.querySelector('.bar-value').textContent.trim()).toBe('61%');
  });

  it('sets the --bar-current CSS variable on the fill element', () => {
    const fixture = setup({ energy: 0.75 });
    const fill = fixture.nativeElement.querySelector('[data-testid="bar-energy"] .bar-fill');
    expect(fill.style.getPropertyValue('--bar-current')).toBe('75%');
  });

  it('sets the background color on the fill element', () => {
    const fixture = setup({ energy: 0.55 });
    const fill = fixture.nativeElement.querySelector('[data-testid="bar-energy"] .bar-fill');
    expect(fill.style.background).toContain('var(--bar-color-energy');
  });

  it('renders bar labels with expected metric names', () => {
    const fixture = setup({ energy: 0.5, valence: 0.6, danceability: 0.7, acousticness: 0.1, instrumental: 0.8 });
    const labels = fixture.nativeElement.querySelectorAll('.bar-label');
    const names = Array.from(labels).map((l: Element) => (l as HTMLElement).textContent.trim());
    expect(names).toEqual(['Energy', 'Valence', 'Dance', 'Acoustic', 'Instrumental']);
  });

  it('handles zero values', () => {
    const fixture = setup({ energy: 0, danceability: 0 });
    const energyBar = fixture.nativeElement.querySelector('[data-testid="bar-energy"]');
    const danceBar = fixture.nativeElement.querySelector('[data-testid="bar-dance"]');
    expect(energyBar.querySelector('.bar-value').textContent.trim()).toBe('0%');
    expect(danceBar.querySelector('.bar-value').textContent.trim()).toBe('0%');
  });

  it('handles maximum values (1.0 = 100%)', () => {
    const fixture = setup({ energy: 1.0, danceability: 1.0 });
    const energyBar = fixture.nativeElement.querySelector('[data-testid="bar-energy"]');
    const danceBar = fixture.nativeElement.querySelector('[data-testid="bar-dance"]');
    expect(energyBar.querySelector('.bar-value').textContent.trim()).toBe('100%');
    expect(danceBar.querySelector('.bar-value').textContent.trim()).toBe('100%');
  });
});

describe('TrackStatsBarsComponent — combined', () => {
  it('renders badges and bars together', () => {
    TestBed.configureTestingModule({ imports: [TrackStatsBarsComponent] });
    const fixture = TestBed.createComponent(TrackStatsBarsComponent);
    setInputValue(fixture.componentInstance.bpm, 126);
    setInputValue(fixture.componentInstance.genre, 'Breakbeat');
    setInputValue(fixture.componentInstance.key, 'C major');
    setInputValue(fixture.componentInstance.mood, 'party');
    setInputValue(fixture.componentInstance.energy, 0.55);
    setInputValue(fixture.componentInstance.valence, 0.61);
    setInputValue(fixture.componentInstance.danceability, 0.99);
    setInputValue(fixture.componentInstance.acousticness, 0.02);
    setInputValue(fixture.componentInstance.instrumental, 0.72);
    fixture.detectChanges();

    const badges = fixture.nativeElement.querySelectorAll('.badge');
    const bars = fixture.nativeElement.querySelectorAll('.bar-item');
    expect(badges.length).toBe(4);
    expect(bars.length).toBe(5);
  });
});

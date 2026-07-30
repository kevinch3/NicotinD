import { TestBed } from '@angular/core/testing';
import { GenreDistributionStripComponent } from './genre-distribution-strip.component';
import { setInputValue } from '../../../testing/signal-input';

describe('GenreDistributionStripComponent', () => {
  function setup(overrides: {
    slices?: { genre: string; count: number; weight: number }[];
    trackCount?: number;
    genreCount?: number;
  }) {
    TestBed.configureTestingModule({ imports: [GenreDistributionStripComponent] });
    const fixture = TestBed.createComponent(GenreDistributionStripComponent);
    if (overrides.slices !== undefined)
      setInputValue(fixture.componentInstance.slices, overrides.slices);
    if (overrides.trackCount !== undefined)
      setInputValue(fixture.componentInstance.trackCount, overrides.trackCount);
    if (overrides.genreCount !== undefined)
      setInputValue(fixture.componentInstance.genreCount, overrides.genreCount);
    fixture.detectChanges();
    return fixture;
  }

  it('renders nothing when there are no slices', () => {
    const fixture = setup({ slices: [] });
    expect(
      fixture.nativeElement.querySelector('[data-testid="genre-distribution-strip"]'),
    ).toBeNull();
  });

  it('renders one bar per slice, sorted by weight descending', () => {
    const fixture = setup({
      slices: [
        { genre: 'Rock', count: 1, weight: 0.25 },
        { genre: 'Cumbia', count: 3, weight: 0.75 },
      ],
    });
    const labels = Array.from(
      fixture.nativeElement.querySelectorAll('.bar-label') as NodeListOf<HTMLElement>,
    ).map((el) => el.textContent?.trim());
    expect(labels).toEqual(['Cumbia', 'Rock']);
  });

  it('renders the percentage value from weight', () => {
    const fixture = setup({ slices: [{ genre: 'Cumbia', count: 3, weight: 0.86 }] });
    const bar = fixture.nativeElement.querySelector('[data-testid="genre-bar-cumbia"]');
    expect(bar.querySelector('.bar-value').textContent.trim()).toBe('86%');
  });

  it('sets the --bar-current CSS variable on the fill element', () => {
    const fixture = setup({ slices: [{ genre: 'Cumbia', count: 3, weight: 0.5 }] });
    const fill = fixture.nativeElement.querySelector('[data-testid="genre-bar-cumbia"] .bar-fill');
    expect(fill.style.getPropertyValue('--bar-current')).toBe('50%');
  });

  it('shows a "N more" caption when genres were folded', () => {
    const fixture = setup({
      slices: [
        { genre: 'Cumbia', count: 3, weight: 0.75 },
        { genre: 'Other', count: 1, weight: 0.25 },
      ],
      genreCount: 4,
    });
    expect(fixture.nativeElement.querySelector('.caption').textContent).toContain('+3 more genres');
  });

  it('does not show a caption when nothing was folded', () => {
    const fixture = setup({
      slices: [{ genre: 'Cumbia', count: 3, weight: 1 }],
      genreCount: 1,
    });
    expect(fixture.nativeElement.querySelector('.caption')).toBeNull();
  });
});

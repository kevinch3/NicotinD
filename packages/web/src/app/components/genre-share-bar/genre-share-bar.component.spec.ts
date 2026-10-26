import { TestBed } from '@angular/core/testing';
import { GenreShareBarComponent, type ShareSegment } from './genre-share-bar.component';
import { setInputValue } from '../../../testing/signal-input';

describe('GenreShareBarComponent (#1572)', () => {
  function setup(slices: ShareSegment[], taggedCount = 10) {
    TestBed.configureTestingModule({ imports: [GenreShareBarComponent] });
    const fixture = TestBed.createComponent(GenreShareBarComponent);
    setInputValue(fixture.componentInstance.slices, slices);
    setInputValue(fixture.componentInstance.taggedCount, taggedCount);
    fixture.detectChanges();
    return fixture;
  }

  const names = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('.legend .name')).map((n) => n.textContent?.trim());

  it('renders nothing without slices', () => {
    expect(setup([]).nativeElement.querySelector('[data-testid="genre-share-bar"]')).toBeNull();
  });

  it('orders segments largest first and keeps "Other" last', () => {
    const el = setup([
      { genre: 'Other', count: 3, weight: 0.3 },
      { genre: 'Salsa', count: 2, weight: 0.2 },
      { genre: 'Pop', count: 5, weight: 0.5 },
    ]).nativeElement;
    expect(names(el)).toEqual(['Pop', 'Salsa', 'Other']);
  });

  it('sizes each segment by its weight and prints the rounded percent', () => {
    const el = setup([
      { genre: 'Pop', count: 2, weight: 2 / 3 },
      { genre: 'Rock', count: 1, weight: 1 / 3 },
    ]).nativeElement;
    const segs = el.querySelectorAll('.seg') as NodeListOf<HTMLElement>;
    expect(Number(segs[0].style.flexGrow)).toBeCloseTo(2 / 3);
    expect(el.querySelector('[data-testid="genre-share-pop"] .value').textContent.trim()).toBe(
      '67%',
    );
  });

  it('steps the tone by rank and gives "Other" the neutral tone', () => {
    const el = setup([
      { genre: 'Pop', count: 2, weight: 0.5 },
      { genre: 'Rock', count: 1, weight: 0.25 },
      { genre: 'Other', count: 1, weight: 0.25 },
    ]).nativeElement;
    const tones = Array.from(el.querySelectorAll('.seg') as NodeListOf<HTMLElement>).map((s) =>
      [...s.classList].find((c) => c.startsWith('tone-')),
    );
    expect(tones).toEqual(['tone-0', 'tone-1', 'tone-other']);
  });

  it('labels the bar with every value, so colour is not the only carrier', () => {
    const el = setup([
      { genre: 'Pop', count: 3, weight: 0.75 },
      { genre: 'Rock', count: 1, weight: 0.25 },
    ]).nativeElement;
    expect(el.querySelector('.bar').getAttribute('aria-label')).toBe('Pop 75%, Rock 25%');
  });
});

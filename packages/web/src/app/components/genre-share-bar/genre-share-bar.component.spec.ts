import { TestBed } from '@angular/core/testing';
import { GenreShareBarComponent, type ShareSegment } from './genre-share-bar.component';
import { setInputValue } from '../../../testing/signal-input';

describe('GenreShareBarComponent (#1572)', () => {
  function setup(slices: ShareSegment[], taggedCount = 10, caption: string | null = null) {
    TestBed.configureTestingModule({ imports: [GenreShareBarComponent] });
    const fixture = TestBed.createComponent(GenreShareBarComponent);
    setInputValue(fixture.componentInstance.slices, slices);
    setInputValue(fixture.componentInstance.taggedCount, taggedCount);
    setInputValue(fixture.componentInstance.caption, caption);
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

  describe('synthesized buckets (#1670)', () => {
    const buckets: ShareSegment[] = [
      { genre: 'Untagged', count: 1, weight: 0.4, kind: 'untagged', percent: 40 },
      { genre: 'Pop', count: 1, weight: 0.3, percent: 30 },
      { genre: 'Other genres', count: 1, weight: 0.3, kind: 'other', percent: 30 },
    ];

    it('sorts other then untagged last, whatever their weight', () => {
      expect(names(setup(buckets).nativeElement)).toEqual(['Pop', 'Other genres', 'Untagged']);
    });

    it('gives each kind the neutral tone and a testid of its own', () => {
      const el = setup(buckets).nativeElement;
      expect(el.querySelector('[data-testid="genre-share-untagged"]')).toBeTruthy();
      expect(el.querySelector('[data-testid="genre-share-other"]')).toBeTruthy();
      const tones = Array.from(el.querySelectorAll('.seg') as NodeListOf<HTMLElement>).map((s) =>
        [...s.classList].find((c) => c.startsWith('tone-')),
      );
      expect(tones).toEqual(['tone-0', 'tone-other', 'tone-other']);
    });

    it('prints an explicit percent instead of rounding the weight', () => {
      const el = setup([
        { genre: 'A', count: 1, weight: 1 / 3, percent: 34 },
        { genre: 'B', count: 1, weight: 1 / 3, percent: 33 },
        { genre: 'C', count: 1, weight: 1 / 3, percent: 33 },
      ]).nativeElement;
      expect(el.querySelector('[data-testid="genre-share-a"] .value').textContent.trim()).toBe(
        '34%',
      );
      expect(el.querySelector('.bar').getAttribute('aria-label')).toBe('A 34%, B 33%, C 33%');
    });

    it('a real tag named "Other genres" does not collide with the bucket', () => {
      const el = setup([
        { genre: 'Other genres', count: 1, weight: 0.5 },
        { genre: 'Other genres', count: 1, weight: 0.5, kind: 'other' },
      ]).nativeElement;
      expect(el.querySelectorAll('.legend li')).toHaveLength(2);
      expect(el.querySelector('[data-testid="genre-share-other"]')).toBeTruthy();
    });

    it('a caption replaces the artist-page caption', () => {
      const el = setup(buckets, 10, 'Of 12 plays').nativeElement;
      expect(el.querySelector('.caption').textContent.trim()).toBe('Of 12 plays');
    });
  });
});

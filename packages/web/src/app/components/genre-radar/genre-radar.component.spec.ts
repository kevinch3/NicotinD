import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { GenreRadarComponent, type GenreSlice } from './genre-radar.component';
import { setInputValue } from '../../../testing/signal-input';

/** Reach the protected computeds the template binds to. */
type Internals = {
  isPolygon: () => boolean;
  axes: () => { label: string; short: string; value: number }[];
  rows: () => GenreSlice[];
  hiddenCount: () => number;
  percent: (w: number) => string;
};

function make(slices: GenreSlice[], trackCount = 10, genreCount = slices.length) {
  const c = TestBed.createComponent(GenreRadarComponent).componentInstance;
  setInputValue(c.slices, slices);
  setInputValue(c.trackCount, trackCount);
  setInputValue(c.genreCount, genreCount);
  return c as unknown as Internals;
}

const THREE: GenreSlice[] = [
  { genre: 'Cumbia', count: 8, weight: 0.8 },
  { genre: 'Folclore', count: 4, weight: 0.4 },
  { genre: 'Rock', count: 2, weight: 0.2 },
];

describe('GenreRadarComponent', () => {
  it('builds one axis per genre, preserving the given order', () => {
    expect(
      make(THREE)
        .axes()
        .map((a) => a.label),
    ).toEqual(['Cumbia', 'Folclore', 'Rock']);
  });

  it('sorts the value table by share, highest first', () => {
    const c = make([
      { genre: 'Rock', count: 2, weight: 0.2 },
      { genre: 'Cumbia', count: 8, weight: 0.8 },
    ]);
    expect(c.rows().map((r) => r.genre)).toEqual(['Cumbia', 'Rock']);
  });

  it('leaves the axis order alone when sorting the table', () => {
    const c = make([
      { genre: 'Rock', count: 2, weight: 0.2 },
      { genre: 'Cumbia', count: 8, weight: 0.8 },
    ]);
    c.rows();
    // A sort that mutated `slices` in place would rotate the polygon too.
    expect(c.axes().map((a) => a.label)).toEqual(['Rock', 'Cumbia']);
  });

  it('draws a polygon only from three axes up', () => {
    expect(make(THREE).isPolygon()).toBe(true);
    expect(make(THREE.slice(0, 2)).isPolygon()).toBe(false);
  });

  it('truncates a long axis label but keeps the full name for the tooltip', () => {
    const [a] = make([{ genre: 'Folk, World, & Country', count: 5, weight: 0.5 }]).axes();
    expect(a.short).toContain('…');
    expect(a.label).toBe('Folk, World, & Country');
  });

  it('counts genres hidden by the "Other" fold, excluding Other itself', () => {
    const withOther = [...THREE, { genre: 'Other', count: 3, weight: 0.3 }];
    // 9 distinct genres; 3 have their own axis → 6 were folded.
    expect(make(withOther, 10, 9).hiddenCount()).toBe(6);
  });

  it('reports no hidden genres when nothing was folded', () => {
    expect(make(THREE, 10, 3).hiddenCount()).toBe(0);
  });

  it('never reports a negative hidden count', () => {
    // genreCount can lag the slice list if the two are fetched separately.
    expect(make(THREE, 10, 1).hiddenCount()).toBe(0);
  });

  it('renders weights as whole percents', () => {
    const c = make(THREE);
    expect(c.percent(0.8)).toBe('80%');
    expect(c.percent(0.125)).toBe('13%');
    expect(c.percent(0)).toBe('0%');
  });
});

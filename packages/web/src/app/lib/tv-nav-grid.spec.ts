import { chunk, gridColumnCount, inferColumnsPerRow } from './tv-nav-grid';

function elWithOffsetTop(top: number): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetTop', { value: top, configurable: true });
  return el;
}

describe('inferColumnsPerRow', () => {
  it('returns 1 for an empty array', () => {
    expect(inferColumnsPerRow([])).toBe(1);
  });

  it('returns 1 when every element has a distinct offsetTop (a single column)', () => {
    const els = [elWithOffsetTop(0), elWithOffsetTop(50), elWithOffsetTop(100)];
    expect(inferColumnsPerRow(els)).toBe(1);
  });

  it('counts consecutive elements sharing the first offsetTop as one row', () => {
    const els = [
      elWithOffsetTop(0),
      elWithOffsetTop(0),
      elWithOffsetTop(0),
      elWithOffsetTop(100),
      elWithOffsetTop(100),
    ];
    expect(inferColumnsPerRow(els)).toBe(3);
  });

  it('treats a single full-width row (all one offsetTop) as one row of that length', () => {
    const els = [elWithOffsetTop(0), elWithOffsetTop(0)];
    expect(inferColumnsPerRow(els)).toBe(2);
  });
});

describe('gridColumnCount', () => {
  function elWithGridTemplateColumns(value: string): HTMLElement {
    const el = document.createElement('div');
    // jsdom's getComputedStyle doesn't resolve real CSS grid layout, so stub
    // the resolved property directly (same approach as offsetTop above).
    vi.spyOn(window, 'getComputedStyle').mockReturnValueOnce({
      gridTemplateColumns: value,
    } as CSSStyleDeclaration);
    return el;
  }

  it('counts space-separated tracks', () => {
    expect(gridColumnCount(elWithGridTemplateColumns('80px 80px 80px'))).toBe(3);
  });

  it('falls back to 1 for "none" (not a grid container)', () => {
    expect(gridColumnCount(elWithGridTemplateColumns('none'))).toBe(1);
  });

  it('falls back to 1 for an empty value (e.g. detached/display:none)', () => {
    expect(gridColumnCount(elWithGridTemplateColumns(''))).toBe(1);
  });
});

describe('chunk', () => {
  it('splits into consecutive chunks of the given size', () => {
    expect(chunk(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('returns one chunk when size >= length', () => {
    expect(chunk(['a', 'b'], 5)).toEqual([['a', 'b']]);
  });

  it('returns an empty array for an empty input', () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it('degrades to one item per chunk for a non-positive size', () => {
    expect(chunk(['a', 'b'], 0)).toEqual([['a'], ['b']]);
  });
});

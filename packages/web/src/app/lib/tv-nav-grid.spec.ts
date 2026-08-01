import { inferColumnsPerRow } from './tv-nav-grid';

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

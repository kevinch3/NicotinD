import { describe, it, expect } from 'vitest';
import { appendUnique } from './append-unique';

describe('appendUnique', () => {
  it('appends a fully-fresh page unchanged', () => {
    const existing = [{ id: 'a' }, { id: 'b' }];
    const page = [{ id: 'c' }, { id: 'd' }];
    expect(appendUnique(existing, page).map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops items whose id is already present (overlapping page)', () => {
    const existing = [{ id: 'a' }, { id: 'b' }];
    const page = [{ id: 'b' }, { id: 'c' }];
    expect(appendUnique(existing, page).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops every item when the page fully overlaps', () => {
    const existing = [{ id: 'a' }, { id: 'b' }];
    const page = [{ id: 'a' }, { id: 'b' }];
    expect(appendUnique(existing, page).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('preserves the existing array reference contents and keeps first occurrence', () => {
    const existing = [{ id: 'a', n: 1 }];
    const page = [{ id: 'a', n: 2 }, { id: 'b', n: 3 }];
    const result = appendUnique(existing, page);
    expect(result).toEqual([{ id: 'a', n: 1 }, { id: 'b', n: 3 }]);
  });

  it('handles empty inputs', () => {
    expect(appendUnique<{ id: string }>([], [])).toEqual([]);
    expect(appendUnique([{ id: 'a' }], [])).toEqual([{ id: 'a' }]);
    expect(appendUnique<{ id: string }>([], [{ id: 'a' }])).toEqual([{ id: 'a' }]);
  });
});

import { createSelection } from './selection';

describe('createSelection', () => {
  it('starts inactive and empty', () => {
    const sel = createSelection();
    expect(sel.active()).toBe(false);
    expect(sel.count()).toBe(0);
    expect(sel.isSelected('x')).toBe(false);
  });

  it('toggle adds then removes an id and tracks count', () => {
    const sel = createSelection();
    sel.toggle('a');
    expect(sel.isSelected('a')).toBe(true);
    expect(sel.count()).toBe(1);
    sel.toggle('b');
    expect(sel.count()).toBe(2);
    sel.toggle('a');
    expect(sel.isSelected('a')).toBe(false);
    expect(sel.count()).toBe(1);
  });

  it('selectAll replaces the set wholesale', () => {
    const sel = createSelection();
    sel.toggle('old');
    sel.selectAll(['a', 'b', 'c']);
    expect(sel.count()).toBe(3);
    expect(sel.isSelected('old')).toBe(false);
    expect(sel.isSelected('b')).toBe(true);
  });

  it('enter activates; exit deactivates and clears', () => {
    const sel = createSelection();
    sel.enter();
    sel.toggle('a');
    expect(sel.active()).toBe(true);
    expect(sel.count()).toBe(1);
    sel.exit();
    expect(sel.active()).toBe(false);
    expect(sel.count()).toBe(0);
  });
});

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

  describe('toggleRange (shift-click)', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];

    it('plain toggle without shift behaves like toggle', () => {
      const sel = createSelection();
      sel.toggleRange('b', order, false);
      expect([...sel.ids()]).toEqual(['b']);
      sel.toggleRange('b', order, false);
      expect(sel.count()).toBe(0);
    });

    it('shift selects the contiguous range from the anchor (inclusive)', () => {
      const sel = createSelection();
      sel.toggleRange('b', order, false); // anchor = b, selects b
      sel.toggleRange('d', order, true); // range b..d
      expect([...sel.ids()].sort()).toEqual(['b', 'c', 'd']);
    });

    it('selects the range regardless of click direction (top→bottom or bottom→top)', () => {
      const sel = createSelection();
      sel.toggleRange('d', order, false);
      sel.toggleRange('a', order, true); // range a..d
      expect([...sel.ids()].sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('shift on an already-selected target deselects the whole range', () => {
      const sel = createSelection();
      sel.selectAll(order);
      sel.toggleRange('a', order, false); // a was selected → now deselected, anchor = a
      sel.toggleRange('c', order, true); // c is selected → deselect a..c
      expect([...sel.ids()].sort()).toEqual(['d', 'e']);
    });

    it('advances the anchor after each click', () => {
      const sel = createSelection();
      sel.toggleRange('b', order, false); // anchor = b
      sel.toggleRange('c', order, false); // anchor = c, selects c
      sel.toggleRange('e', order, true); // range c..e
      expect([...sel.ids()].sort()).toEqual(['b', 'c', 'd', 'e']);
    });

    it('falls back to a plain toggle when shift is held but no anchor exists', () => {
      const sel = createSelection();
      sel.toggleRange('c', order, true);
      expect([...sel.ids()]).toEqual(['c']);
    });

    it('resets the anchor on enter and exit', () => {
      const sel = createSelection();
      sel.toggleRange('b', order, false);
      sel.exit(); // clears anchor
      sel.toggleRange('d', order, true); // no anchor → plain toggle
      expect([...sel.ids()]).toEqual(['d']);

      sel.enter(); // clears anchor again
      sel.toggleRange('a', order, true); // no anchor → plain toggle
      expect([...sel.ids()].sort()).toEqual(['a', 'd']);
    });
  });
});

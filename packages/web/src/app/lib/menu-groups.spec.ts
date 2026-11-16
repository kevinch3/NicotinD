import { startsGroup, type MenuGroup } from './menu-groups';

const rows = (...groups: (MenuGroup | undefined)[]) => groups.map((group) => ({ group }));
const separatorsAbove = (list: { group?: MenuGroup }[]) =>
  list.map((_, i) => i).filter((i) => startsGroup(list, i));

describe('startsGroup (#2006)', () => {
  it('never puts a separator above the first row', () => {
    expect(startsGroup(rows('play'), 0)).toBe(false);
    expect(startsGroup([], 0)).toBe(false);
  });

  it('puts one where the group changes, and none inside a group', () => {
    expect(separatorsAbove(rows('play', 'play', 'goto', 'goto', 'keep', 'remove'))).toEqual([
      2, 4, 5,
    ]);
  });

  it('treats ungrouped rows as a group of their own, after whatever came before', () => {
    expect(separatorsAbove(rows('play', 'remove', undefined, undefined))).toEqual([1, 2]);
    expect(separatorsAbove(rows(undefined, undefined))).toEqual([]);
  });

  it('is false past the end of the list', () => {
    expect(startsGroup(rows('play'), 5)).toBe(false);
  });
});

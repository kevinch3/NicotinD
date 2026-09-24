import { isTextEntryTarget } from './text-entry';

describe('isTextEntryTarget', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it.each(['input', 'textarea', 'select'])('%s is a text-entry target', (tag) => {
    expect(isTextEntryTarget(document.createElement(tag))).toBe(true);
  });

  it('a descendant of a contenteditable is one, a contenteditable="false" island is not', () => {
    document.body.innerHTML =
      '<div contenteditable="true"><span id="in">x</span></div><div contenteditable="false" id="off"></div>';
    expect(isTextEntryTarget(document.getElementById('in'))).toBe(true);
    expect(isTextEntryTarget(document.getElementById('off'))).toBe(false);
  });

  it('buttons, plain elements, window and null are not', () => {
    expect(isTextEntryTarget(document.createElement('button'))).toBe(false);
    expect(isTextEntryTarget(document.createElement('div'))).toBe(false);
    expect(isTextEntryTarget(window)).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});

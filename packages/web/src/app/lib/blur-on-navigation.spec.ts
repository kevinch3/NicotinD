import { afterEach, describe, expect, it } from 'vitest';
import { blurFocusedFieldOnNavigation } from './blur-on-navigation';

function focused<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  setup?: (el: HTMLElementTagNameMap[K]) => void,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  setup?.(el);
  document.body.appendChild(el);
  el.focus();
  expect(document.activeElement).toBe(el);
  return el;
}

describe('blurFocusedFieldOnNavigation (#1635)', () => {
  afterEach(() => document.body.replaceChildren());

  it('blurs a focused text input when the path changes', () => {
    const input = focused('input');
    expect(blurFocusedFieldOnNavigation('/library', '/artist/1')).toBe(true);
    expect(document.activeElement).not.toBe(input);
  });

  it('blurs a focused textarea and a search input', () => {
    focused('textarea');
    expect(blurFocusedFieldOnNavigation('/a', '/b')).toBe(true);
    focused('input', (el) => (el.type = 'search'));
    expect(blurFocusedFieldOnNavigation('/a', '/b')).toBe(true);
  });

  it('keeps focus when only the query or the fragment changes', () => {
    const input = focused('input');
    expect(blurFocusedFieldOnNavigation('/search?q=a', '/search?q=ab')).toBe(false);
    expect(blurFocusedFieldOnNavigation('/search', '/search#top')).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('leaves a focused button or link alone, so D-pad and keyboard focus survive', () => {
    const button = focused('button');
    expect(blurFocusedFieldOnNavigation('/library', '/artist/1')).toBe(false);
    expect(document.activeElement).toBe(button);
    const range = focused('input', (el) => (el.type = 'range'));
    expect(blurFocusedFieldOnNavigation('/library', '/artist/1')).toBe(false);
    expect(document.activeElement).toBe(range);
  });

  it('does nothing when nothing is focused', () => {
    expect(blurFocusedFieldOnNavigation('/library', '/artist/1')).toBe(false);
  });
});

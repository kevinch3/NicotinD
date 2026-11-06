import { afterEach, describe, expect, it } from 'vitest';
import { scrollRootElement, scrollRootTo, scrollRootTop } from './scroll-root';

describe('scroll root', () => {
  afterEach(() => document.body.replaceChildren());

  it('falls back to the document when no shell scroller is mounted', () => {
    expect(scrollRootElement()).toBeNull();
    expect(scrollRootTop()).toBe(window.scrollY);
  });

  it('reads and writes the shell scroller, not the window', () => {
    const main = document.createElement('main');
    main.setAttribute('data-scroll-root', '');
    const calls: unknown[] = [];
    main.scrollTo = ((o: unknown) => calls.push(o)) as typeof main.scrollTo;
    Object.defineProperty(main, 'scrollTop', { value: 120, configurable: true });
    document.body.append(main);

    expect(scrollRootTop()).toBe(120);
    scrollRootTo(40);
    expect(calls).toEqual([{ top: 40 }]);
  });
});

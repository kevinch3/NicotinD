import {
  SKIP_THRESHOLD_PX,
  canStartSheetSkip,
  canStartSkipSwipe,
  gestureOrigin,
  skipDirection,
} from './swipe-to-skip';
import { FLICK_PX_PER_MS } from './vertical-swipe';

describe('skipDirection', () => {
  it('left past the threshold is next, right is previous', () => {
    expect(skipDirection(-(SKIP_THRESHOLD_PX + 1), 0)).toBe('next');
    expect(skipDirection(SKIP_THRESHOLD_PX + 1, 0)).toBe('prev');
  });

  it('a short slow drag commits nothing', () => {
    expect(skipDirection(-(SKIP_THRESHOLD_PX - 1), 0)).toBeNull();
    expect(skipDirection(SKIP_THRESHOLD_PX - 1, -0.1)).toBeNull();
    expect(skipDirection(0, 0)).toBeNull();
  });

  it('a short flick commits in its direction', () => {
    expect(skipDirection(-30, -FLICK_PX_PER_MS)).toBe('next');
    expect(skipDirection(30, FLICK_PX_PER_MS)).toBe('prev');
  });

  it('a flick against the travel does not commit', () => {
    expect(skipDirection(-30, FLICK_PX_PER_MS * 4)).toBeNull();
    expect(skipDirection(30, -FLICK_PX_PER_MS * 4)).toBeNull();
  });
});

describe('canStartSkipSwipe', () => {
  it.each([
    ['a button', () => document.createElement('button')],
    ['a link', () => document.createElement('a')],
    [
      'the seek bar',
      () => {
        const el = document.createElement('div');
        el.setAttribute('data-seek', '');
        return el;
      },
    ],
    ['the range input', () => document.createElement('input')],
    ['the waveform', () => document.createElement('app-now-playing-waveform')],
    [
      'inside a button',
      () => {
        const b = document.createElement('button');
        const icon = document.createElement('span');
        b.appendChild(icon);
        return icon;
      },
    ],
  ])('refuses %s', (_label, make) => {
    expect(canStartSkipSwipe(make())).toBe(false);
  });

  it('accepts the cover and plain text', () => {
    expect(canStartSkipSwipe(document.createElement('img'))).toBe(true);
    expect(canStartSkipSwipe(document.createElement('p'))).toBe(true);
    expect(canStartSkipSwipe(null)).toBe(true);
  });

  // #1652: a neighbour sliver is a button for its tap, but a drag from it is a
  // drag of the cover strip it sits on.
  function sliverIn(parent: Element): Element {
    const sliver = document.createElement('button');
    sliver.setAttribute('data-np-sliver', '');
    const img = document.createElement('img');
    sliver.appendChild(img);
    parent.appendChild(sliver);
    return img;
  }

  it('accepts a neighbour sliver, though it is a button', () => {
    expect(canStartSkipSwipe(sliverIn(document.createElement('div')))).toBe(true);
  });

  it('a sliver inside an excluded control is still refused', () => {
    expect(canStartSkipSwipe(sliverIn(document.createElement('a')))).toBe(false);
  });
});

describe('gestureOrigin', () => {
  it('maps a sliver (or anything in it) to the strip it sits on', () => {
    const strip = document.createElement('div');
    const sliver = document.createElement('button');
    sliver.setAttribute('data-np-sliver', '');
    const img = document.createElement('img');
    sliver.appendChild(img);
    strip.appendChild(sliver);
    expect(gestureOrigin(img)).toBe(strip);
    expect(gestureOrigin(sliver)).toBe(strip);
  });

  it('leaves every other target as it is', () => {
    const button = document.createElement('button');
    expect(gestureOrigin(button)).toBe(button);
    expect(gestureOrigin(null)).toBeNull();
  });
});

describe('canStartSheetSkip', () => {
  it('allows the sheet background and the cover, not just the artwork', () => {
    expect(canStartSheetSkip(document.createElement('div'))).toBe(true);
    expect(canStartSheetSkip(document.createElement('img'))).toBe(true);
  });

  it('refuses anything inside the scrolling panel zone', () => {
    const zone = document.createElement('div');
    zone.setAttribute('data-np-zone', 'panel');
    const row = document.createElement('span');
    zone.appendChild(row);
    expect(canStartSheetSkip(row)).toBe(false);
  });

  it('still refuses controls and a missing target', () => {
    expect(canStartSheetSkip(document.createElement('button'))).toBe(false);
    expect(canStartSheetSkip(null)).toBe(true);
  });
});

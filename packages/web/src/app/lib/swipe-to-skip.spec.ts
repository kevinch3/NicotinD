import { SKIP_THRESHOLD_PX, canStartSkipSwipe, skipDirection } from './swipe-to-skip';
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
});

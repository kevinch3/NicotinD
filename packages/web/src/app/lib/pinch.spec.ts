import { createPinch } from './pinch';

const touch = (type: string, id: number, x: number, y: number, pointerType = 'touch') =>
  new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, pointerType, bubbles: true });

function setup() {
  const ratios: number[] = [];
  const log: string[] = [];
  const pinch = createPinch({
    onStart: () => log.push('start'),
    onChange: (r) => ratios.push(r),
    onEnd: () => log.push('end'),
  });
  const move = (id: number, x: number, y: number) =>
    document.dispatchEvent(touch('pointermove', id, x, y));
  const up = (id: number, type = 'pointerup') => document.dispatchEvent(touch(type, id, 0, 0));
  return { pinch, ratios, log, move, up };
}

describe('createPinch', () => {
  it('one finger is not a pinch', () => {
    const { pinch, ratios, log, move, up } = setup();
    expect(pinch.down(touch('pointerdown', 1, 100, 100))).toBe(false);
    move(1, 150, 100);
    expect(ratios).toEqual([]);
    expect(pinch.active()).toBe(false);
    up(1);
    expect(log).toEqual([]);
  });

  it('a second finger starts one, and the spread is reported as a ratio', () => {
    const { pinch, ratios, log, move } = setup();
    pinch.down(touch('pointerdown', 1, 100, 100));
    expect(pinch.down(touch('pointerdown', 2, 200, 100))).toBe(true);
    expect(log).toEqual(['start']);
    move(2, 300, 100); // 100 → 200 px apart
    expect(ratios.at(-1)).toBeCloseTo(2);
    move(1, 250, 100); // 50 px apart
    expect(ratios.at(-1)).toBeCloseTo(0.5);
    pinch.destroy();
  });

  it('ends when either finger lifts, and the one left does nothing', () => {
    const { pinch, ratios, log, move, up } = setup();
    pinch.down(touch('pointerdown', 1, 100, 100));
    pinch.down(touch('pointerdown', 2, 200, 100));
    up(2);
    expect(log).toEqual(['start', 'end']);
    const before = ratios.length;
    move(1, 400, 400);
    expect(ratios).toHaveLength(before);
    // Still spent: the caller must not start a pan with the finger that stayed.
    expect(pinch.active()).toBe(true);
    // Putting the second finger back does not restart it mid-gesture.
    expect(pinch.down(touch('pointerdown', 3, 300, 100))).toBe(false);
    up(1);
    up(3);
    expect(pinch.active()).toBe(false);
  });

  it('starts fresh once every finger is up', () => {
    const { pinch, log, up } = setup();
    pinch.down(touch('pointerdown', 1, 100, 100));
    pinch.down(touch('pointerdown', 2, 200, 100));
    up(1);
    up(2);
    pinch.down(touch('pointerdown', 5, 0, 0));
    expect(pinch.down(touch('pointerdown', 6, 0, 80))).toBe(true);
    expect(log).toEqual(['start', 'end', 'start']);
    pinch.destroy();
  });

  it('a cancelled touch ends it like a lift', () => {
    const { pinch, log, up } = setup();
    pinch.down(touch('pointerdown', 1, 100, 100));
    pinch.down(touch('pointerdown', 2, 200, 100));
    up(1, 'pointercancel');
    expect(log).toEqual(['start', 'end']);
    pinch.destroy();
  });

  it('ignores a mouse and a pen, and two fingers on the same spot', () => {
    const { pinch, log } = setup();
    expect(pinch.down(touch('pointerdown', 1, 100, 100, 'mouse'))).toBe(false);
    expect(pinch.down(touch('pointerdown', 2, 200, 100, 'mouse'))).toBe(false);
    pinch.down(touch('pointerdown', 3, 50, 50));
    expect(pinch.down(touch('pointerdown', 4, 50, 50))).toBe(false);
    expect(log).toEqual([]);
    pinch.destroy();
  });

  it('destroy stops listening', () => {
    const { pinch, ratios, move } = setup();
    pinch.down(touch('pointerdown', 1, 100, 100));
    pinch.down(touch('pointerdown', 2, 200, 100));
    pinch.destroy();
    move(2, 400, 100);
    expect(ratios).toEqual([]);
  });
});

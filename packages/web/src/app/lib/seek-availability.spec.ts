import {
  SEEK_AVAILABILITY_EPSILON_SEC,
  seekTargetIsAvailable,
  seekableEnd,
  timeRangesToArray,
} from './seek-availability';

/** jsdom cannot construct a TimeRanges — this is the shape the helpers read. */
function ranges(...pairs: [number, number][]): TimeRanges {
  return {
    length: pairs.length,
    start: (i: number) => pairs[i][0],
    end: (i: number) => pairs[i][1],
  } as unknown as TimeRanges;
}

describe('timeRangesToArray', () => {
  it('snapshots every range as plain data', () => {
    expect(timeRangesToArray(ranges([0, 30], [60, 90]))).toEqual([
      { start: 0, end: 30 },
      { start: 60, end: 90 },
    ]);
  });

  it('returns empty for a missing TimeRanges (element not ready)', () => {
    expect(timeRangesToArray(null)).toEqual([]);
    expect(timeRangesToArray(undefined)).toEqual([]);
    expect(timeRangesToArray(ranges())).toEqual([]);
  });

  it('drops non-finite entries rather than propagating NaN into the gate', () => {
    expect(timeRangesToArray(ranges([0, Number.NaN], [10, 20]))).toEqual([{ start: 10, end: 20 }]);
  });
});

describe('seekableEnd', () => {
  it('reports the furthest reachable position across ranges', () => {
    expect(
      seekableEnd([
        { start: 0, end: 30 },
        { start: 60, end: 90 },
      ]),
    ).toBe(90);
  });

  it('is 0 when there is nothing to seek into', () => {
    expect(seekableEnd([])).toBe(0);
  });
});

describe('seekTargetIsAvailable', () => {
  const loaded = [{ start: 0, end: 60 }];

  it('accepts a target comfortably inside a loaded range', () => {
    expect(seekTargetIsAvailable(30, loaded)).toBe(true);
  });

  it('accepts the start edge of a range', () => {
    expect(seekTargetIsAvailable(0, loaded)).toBe(true);
  });

  // The whole point of the epsilon: landing on the last byte the browser holds
  // makes it fire `ended` rather than continue, which downstream is
  // indistinguishable from the track finishing.
  it('rejects the final epsilon of a range', () => {
    expect(seekTargetIsAvailable(60, loaded)).toBe(false);
    expect(seekTargetIsAvailable(60 - SEEK_AVAILABILITY_EPSILON_SEC / 2, loaded)).toBe(false);
    expect(seekTargetIsAvailable(60 - SEEK_AVAILABILITY_EPSILON_SEC, loaded)).toBe(true);
  });

  it('rejects a target past everything loaded (the reported bug)', () => {
    expect(seekTargetIsAvailable(180, loaded)).toBe(false);
  });

  it('rejects a target in a gap between ranges', () => {
    expect(
      seekTargetIsAvailable(45, [
        { start: 0, end: 30 },
        { start: 60, end: 90 },
      ]),
    ).toBe(false);
  });

  it('accepts a target inside a later range', () => {
    expect(
      seekTargetIsAvailable(70, [
        { start: 0, end: 30 },
        { start: 60, end: 90 },
      ]),
    ).toBe(true);
  });

  it('rejects when nothing is seekable yet', () => {
    expect(seekTargetIsAvailable(10, [])).toBe(false);
  });

  it('rejects a nonsensical target', () => {
    expect(seekTargetIsAvailable(-5, loaded)).toBe(false);
    expect(seekTargetIsAvailable(Number.NaN, loaded)).toBe(false);
  });
});

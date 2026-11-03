import { remoteClockAt } from './remote-clock';

describe('remoteClockAt', () => {
  it('advances the reported position on the wall clock', () => {
    expect(remoteClockAt(10, 1_000, 200, 3_500)).toBe(12.5);
  });

  it('clamps to a known duration', () => {
    expect(remoteClockAt(199, 0, 200, 5_000)).toBe(200);
  });

  it('does not clamp when the duration is unknown', () => {
    expect(remoteClockAt(10, 0, 0, 5_000)).toBe(15);
  });

  it('never runs backwards on a clock that reads before the report', () => {
    expect(remoteClockAt(10, 5_000, 200, 4_000)).toBe(10);
  });
});

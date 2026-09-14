import { vi } from 'vitest';
import { KaraokeBrowseMode } from './karaoke-browse';

describe('KaraokeBrowseMode (#1134)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts on the 2-line auto-follow view', () => {
    expect(new KaraokeBrowseMode().browsing()).toBe(false);
  });

  it('an interaction enters browse, and idling leaves it again', () => {
    const mode = new KaraokeBrowseMode();
    mode.interact();
    expect(mode.browsing()).toBe(true);

    vi.advanceTimersByTime(KaraokeBrowseMode.IDLE_MS - 1);
    expect(mode.browsing()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(mode.browsing()).toBe(false);
  });

  it('every interaction restarts the idle countdown', () => {
    const mode = new KaraokeBrowseMode();
    mode.interact();
    vi.advanceTimersByTime(KaraokeBrowseMode.IDLE_MS - 500);
    mode.interact();
    vi.advanceTimersByTime(1000);
    expect(mode.browsing()).toBe(true);
  });

  it('toggle flips between the two views', () => {
    const mode = new KaraokeBrowseMode();
    mode.toggle();
    expect(mode.browsing()).toBe(true);
    mode.toggle();
    expect(mode.browsing()).toBe(false);
  });

  it('leave returns to auto-follow at once and disarms the countdown', () => {
    const mode = new KaraokeBrowseMode();
    mode.interact();
    mode.leave();
    expect(mode.browsing()).toBe(false);
    // A countdown that survived would flip nothing — but it must not exist.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('destroy disarms the countdown so it can never fire past its owner', () => {
    const mode = new KaraokeBrowseMode();
    mode.interact();
    mode.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(mode.browsing()).toBe(true); // destroy is not a view change
  });
});

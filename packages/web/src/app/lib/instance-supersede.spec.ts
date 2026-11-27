import { describe, expect, it, vi } from 'vitest';
import {
  announceLaunch,
  supersedesOlderInstances,
  type InstanceChannel,
} from './instance-supersede';

/** Two ends of one channel: like `BroadcastChannel`, never echoes to the sender. */
function pair(): [InstanceChannel, InstanceChannel] {
  const a: InstanceChannel = { onmessage: null, postMessage: (d) => deliver(b, d) };
  const b: InstanceChannel = { onmessage: null, postMessage: (d) => deliver(a, d) };
  const deliver = (to: InstanceChannel, data: unknown): void =>
    to.onmessage?.({ data } as MessageEvent);
  return [a, b];
}

describe('announceLaunch (#2074)', () => {
  it('a newer launch tells the older instance to stand down, and not itself', () => {
    const [older, newer] = pair();
    const olderStop = vi.fn();
    const newerStop = vi.fn();
    announceLaunch({ channel: older, onSuperseded: olderStop });
    announceLaunch({ channel: newer, onSuperseded: newerStop });
    expect(olderStop).toHaveBeenCalledTimes(1);
    expect(newerStop).not.toHaveBeenCalled();
  });

  it('ignores anything else on the channel', () => {
    const [a, b] = pair();
    const stop = vi.fn();
    announceLaunch({ channel: a, onSuperseded: stop });
    b.postMessage({ kind: 'something-else' });
    b.postMessage(null);
    expect(stop).not.toHaveBeenCalled();
  });
});

describe('supersedesOlderInstances', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
  const desktop = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
  const win = (userAgent: string, standalone: boolean) => ({
    navigator: { userAgent, standalone, maxTouchPoints: 5 },
    matchMedia: () => ({ matches: false }),
  });

  it('only for the installed iOS app, where a second instance means the first was closed', () => {
    expect(supersedesOlderInstances(win(iphone, true))).toBe(true);
    // Safari tabs and desktop windows are opened side by side on purpose.
    expect(supersedesOlderInstances(win(iphone, false))).toBe(false);
    expect(supersedesOlderInstances(win(desktop, true))).toBe(false);
  });
});

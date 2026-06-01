import { describe, it, expect, mock } from 'bun:test';
import type { NicotinDConfig } from '@nicotind/core';
import { ServiceManager } from './manager.js';
import type {
  IServiceStrategy,
  ServiceDefinition,
  ServiceHandle,
} from './strategies/strategy.js';

function fakeStrategy() {
  const start = mock(async (s: ServiceDefinition): Promise<ServiceHandle> => ({ name: s.name, pid: 1 }));
  const stop = mock(async () => undefined);
  const strategy = {
    start,
    stop,
    restart: mock(async (_h: ServiceHandle, s: ServiceDefinition) => ({ name: s.name })),
    isRunning: mock(async () => true),
    getLogs: mock(async () => []),
  } as unknown as IServiceStrategy;
  return { strategy, start, stop };
}

const DEF: ServiceDefinition = {
  name: 'navidrome',
  command: 'navidrome',
  args: [],
  env: {},
  healthCheckUrl: 'http://localhost:0/ping',
  healthCheckTimeoutMs: 10,
};

// startWithRetry is private; reach it through a typed cast for the unit test.
type RetryFn = (
  name: string,
  def: ServiceDefinition,
  attempts: number,
  opts?: { healthCheck?: (u: string, t: number) => Promise<boolean>; backoffMs?: number },
) => Promise<boolean>;
const retryOf = (m: ServiceManager): RetryFn =>
  (m as unknown as { startWithRetry: RetryFn }).startWithRetry.bind(m);

describe('ServiceManager.startWithRetry', () => {
  it('retries past early-exit attempts and succeeds, stopping the dead processes', async () => {
    const { strategy, start, stop } = fakeStrategy();
    const mgr = new ServiceManager(strategy, {} as NicotinDConfig);

    // Unhealthy on attempts 1 and 2, healthy on 3.
    let calls = 0;
    const healthCheck = mock(async () => ++calls >= 3);

    const ok = await retryOf(mgr)('navidrome', DEF, 3, { healthCheck, backoffMs: 0 });

    expect(ok).toBe(true);
    expect(start).toHaveBeenCalledTimes(3);
    // The two failed attempts' processes were stopped before retrying.
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('returns false when every attempt stays unhealthy', async () => {
    const { strategy, start, stop } = fakeStrategy();
    const mgr = new ServiceManager(strategy, {} as NicotinDConfig);
    const healthCheck = mock(async () => false);

    const ok = await retryOf(mgr)('navidrome', DEF, 3, { healthCheck, backoffMs: 0 });

    expect(ok).toBe(false);
    expect(start).toHaveBeenCalledTimes(3);
    expect(stop).toHaveBeenCalledTimes(3);
  });

  it('starts once and does not stop when the first attempt is healthy', async () => {
    const { strategy, start, stop } = fakeStrategy();
    const mgr = new ServiceManager(strategy, {} as NicotinDConfig);
    const healthCheck = mock(async () => true);

    const ok = await retryOf(mgr)('navidrome', DEF, 3, { healthCheck, backoffMs: 0 });

    expect(ok).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });
});

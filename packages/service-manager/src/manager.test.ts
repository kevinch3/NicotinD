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
  const restart = mock(async (_h: ServiceHandle, s: ServiceDefinition) => ({ name: s.name }));
  const strategy = {
    start,
    stop,
    restart,
    isRunning: mock(async () => true),
    getLogs: mock(async () => []),
  } as unknown as IServiceStrategy;
  return { strategy, start, stop, restart };
}

const externalConfig = { mode: 'external' } as NicotinDConfig;

describe('ServiceManager', () => {
  it('skips slskd startup in external mode', async () => {
    const { strategy, start } = fakeStrategy();
    const mgr = new ServiceManager(strategy, externalConfig);
    await mgr.startSlskd();
    expect(start).not.toHaveBeenCalled();
  });

  it('startAll only manages slskd (Navidrome is gone)', async () => {
    const { strategy, start } = fakeStrategy();
    const mgr = new ServiceManager(strategy, externalConfig);
    await mgr.startAll();
    // external mode → nothing started, and crucially no Navidrome path exists
    expect(start).not.toHaveBeenCalled();
  });

  it('restartService is a no-op for unknown / removed services', async () => {
    const { strategy, restart } = fakeStrategy();
    const mgr = new ServiceManager(strategy, externalConfig);
    // No handle registered, and 'navidrome' is no longer a managed service.
    await mgr.restartService('navidrome');
    expect(restart).not.toHaveBeenCalled();
  });
});

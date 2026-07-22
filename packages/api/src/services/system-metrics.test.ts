/**
 * Pure helpers + dependency-free boundary for system-metrics. The metrics
 * functions take an injectable `os`-shim + GPU-probe shim so we can drive
 * CPU deltas, memory probes, and the vendor CLI ladder without spawning real
 * processes or touching the kernel.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { arch, cpus as osCpus, freemem as osFreemem, platform as osPlatform, totalmem as osTotalmem } from 'node:os';

import {
  collectMetrics,
  readCpu,
  readGpu,
  readHardware,
  readMemory,
  _resetMetricsState,
  type OsShim,
  type GpuProbe,
} from './system-metrics.js';

function makeCores(count: number, times: { idle: number; user?: number; nice?: number; sys?: number; irq?: number }) {
  return Array.from({ length: count }, () => ({
    model: 'Test CPU',
    speed: 3000,
    times: { user: 100, nice: 0, sys: 10, irq: 0, ...times },
  }));
}

function makeOs(overrides: Partial<OsShim> = {}): OsShim {
  return {
    cpus: osCpus,
    totalmem: osTotalmem,
    freemem: osFreemem,
    arch,
    platform: osPlatform,
    ...overrides,
  };
}

const alwaysNullProbe: GpuProbe = { nvidia: async () => null, rocm: async () => null, mac: async () => null };

afterEach(() => {
  _resetMetricsState();
});

describe('readCpu', () => {
  beforeEach(() => {
    _resetMetricsState();
  });

  it('returns 0 % on the first call (no baseline)', () => {
    const os = makeOs({ cpus: () => makeCores(4, { idle: 1000 }) as unknown as ReturnType<typeof osCpus> });
    const r = readCpu({ os });
    expect(r.percent).toBe(0);
    expect(r.cores).toBe(4);
    expect(r.model).toBe('Test CPU');
  });

  it('computes a positive delta vs the previous sample', () => {
    const coresA = makeCores(4, { user: 200, idle: 1000 });
    readCpu({ os: makeOs({ cpus: () => coresA as unknown as ReturnType<typeof osCpus> }) });
    const coresB = makeCores(4, { user: 700, idle: 1200 });
    const r = readCpu({ os: makeOs({ cpus: () => coresB as unknown as ReturnType<typeof osCpus> }) });
    // Delta: user +500, idle +200 → busy 500/700 ≈ 71 %.
    expect(r.percent).toBeGreaterThan(60);
    expect(r.percent).toBeLessThanOrEqual(100);
  });

  it('clamps to 0..100 under any sample order', () => {
    const coresA = makeCores(2, { user: 0, idle: 1000 });
    readCpu({ os: makeOs({ cpus: () => coresA as unknown as ReturnType<typeof osCpus> }) });
    const coresB = makeCores(2, { user: 0, idle: 5000 });
    const r = readCpu({ os: makeOs({ cpus: () => coresB as unknown as ReturnType<typeof osCpus> }) });
    expect(r.percent).toBeGreaterThanOrEqual(0);
    expect(r.percent).toBeLessThanOrEqual(100);
  });
});

describe('readMemory', () => {
  it('honors the injected os shim for total/free', () => {
    const os = makeOs({ totalmem: () => 8000, freemem: () => 2000 });
    const r = readMemory({ os });
    expect(r.totalBytes).toBe(8000);
    expect(r.freeBytes).toBe(2000);
    expect(r.usedBytes).toBe(6000);
  });

  it('reads RSS + heap from process.memoryUsage (real process)', () => {
    const r = readMemory({ os: makeOs({ totalmem: () => 1000, freemem: () => 0 }) });
    expect(r.processRssBytes).toBeGreaterThan(0);
    expect(r.processHeapBytes).toBeGreaterThan(0);
  });
});

describe('readHardware', () => {
  it('surfaces the detected GPU vendor + name', () => {
    const os = makeOs({ arch: () => 'x64', platform: () => 'linux', cpus: () => makeCores(4, { idle: 1 }) as unknown as ReturnType<typeof osCpus> });
    const h = readHardware({ vendor: 'nvidia', name: 'GeForce RTX 4090', percent: 12 }, { os });
    expect(h.gpuDetected?.vendor).toBe('nvidia');
    expect(h.gpuDetected?.name).toBe('GeForce RTX 4090');
    expect(h.platform).toBe('linux');
    expect(h.arch).toBe('x64');
  });

  it('reports null GPU when the probe returned nothing', () => {
    const os = makeOs({ platform: () => 'linux' });
    const h = readHardware(null, { os });
    expect(h.gpuDetected).toBeNull();
  });
});

describe('readGpu', () => {
  it('returns null when every probe returns null (Linux box without vendor CLIs)', async () => {
    const os = makeOs({ platform: () => 'linux' });
    const r = await readGpu(Date.now(), { os, probe: alwaysNullProbe });
    expect(r).toBeNull();
  });

  it('returns the nvidia-smi snapshot when that probe wins on Linux', async () => {
    const os = makeOs({ platform: () => 'linux' });
    const probe: GpuProbe = {
      nvidia: async () => ({ vendor: 'nvidia', percent: 25, name: 'RTX 4090' }),
      rocm: async () => null,
      mac: async () => null,
    };
    const r = await readGpu(Date.now(), { os, probe });
    expect(r?.vendor).toBe('nvidia');
    expect(r?.percent).toBe(25);
    expect(r?.name).toBe('RTX 4090');
  });

  it('falls through to rocm-smi when nvidia returns null', async () => {
    const os = makeOs({ platform: () => 'linux' });
    const probe: GpuProbe = {
      nvidia: async () => null,
      rocm: async () => ({ vendor: 'amd', percent: 60 }),
      mac: async () => null,
    };
    const r = await readGpu(Date.now(), { os, probe });
    expect(r?.vendor).toBe('amd');
    expect(r?.percent).toBe(60);
  });

  it('uses the mac probe on darwin (no nvidia/rocm fallback)', async () => {
    const os = makeOs({ platform: () => 'darwin' });
    const probe: GpuProbe = {
      nvidia: async () => ({ vendor: 'nvidia', percent: 99 }),
      rocm: async () => null,
      mac: async () => ({ vendor: 'apple', name: 'M3 Max', percent: undefined }),
    };
    const r = await readGpu(Date.now(), { os, probe });
    expect(r?.vendor).toBe('apple');
  });
});

describe('collectMetrics', () => {
  it('returns a graceful snapshot even when the GPU probe throws', async () => {
    const os = makeOs({ totalmem: () => 1000, freemem: () => 100 });
    const probe: GpuProbe = {
      nvidia: () => Promise.reject(new Error('boom')),
      rocm: async () => null,
      mac: async () => null,
    };
    const m = await collectMetrics({ os, probe });
    expect(m.gpu).toBeNull();
    expect(m.memory.totalBytes).toBe(1000);
    expect(m.memory.usedBytes).toBe(900);
    expect(m.cpu.cores).toBeGreaterThan(0);
  });
});

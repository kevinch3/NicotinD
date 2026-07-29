import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { MetricPillComponent } from './metric-pill.component';
import type { CpuSnapshot, GpuSnapshot, MemorySnapshot } from '../../services/api/api-types';
import { setInputValue } from '../../../testing/signal-input';

/**
 * DOM rendering is covered by the existing e2e + AdminComponent integration
 * tests — the unit suite here guards the pure computation rules. Inputs are
 * driven via `setInputValue`; each scenario builds a fresh component (see
 * `src/testing/signal-input.ts` for why that matters).
 */
const sampleCpu: CpuSnapshot = { percent: 42, cores: 8, model: 'Test CPU' };
const sampleMem: MemorySnapshot = {
  totalBytes: 16 * 1024 ** 3,
  usedBytes: 8 * 1024 ** 3,
  freeBytes: 8 * 1024 ** 3,
  processRssBytes: 412 * 1024 * 1024,
  processHeapBytes: 96 * 1024 * 1024,
};
const sampleGpu: GpuSnapshot = { vendor: 'nvidia', percent: 33, name: 'RTX 4090' };
const sampleAppleGpu: GpuSnapshot = { vendor: 'apple', name: 'M3 Max' };

function make(): MetricPillComponent {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [MetricPillComponent] });
  return TestBed.createComponent(MetricPillComponent).componentInstance;
}

describe('MetricPillComponent', () => {
  it('returns sensible fallbacks when nothing is set (default = null inputs)', () => {
    const c = make();
    expect(c.cpuLabel()).toBe('—');
    expect(c.memoryLabel()).toBe('—');
    expect(c.gpuLabel()).toBe('—');
    expect(c.memoryProcessLabel()).toBe('');
    expect(c.cpuRatio()).toBe(0);
    expect(c.memoryRatio()).toBe(0);
    expect(c.gpuRatio()).toBe(0);
  });

  it('formats the CPU pill label as `${percent}%`', () => {
    const c = make();
    setInputValue(c.cpu, sampleCpu);
    expect(c.cpuLabel()).toBe('42%');
  });

  it('formats the memory pill label as `${used} / ${total}` and surfaces process RSS', () => {
    const c = make();
    setInputValue(c.memory, sampleMem);
    expect(c.memoryLabel()).toBe('8.0 GB / 16.0 GB');
    expect(c.memoryProcessLabel()).toBe('412 MB process');
  });

  it('formats the GPU pill label as `${percent}%` when the vendor exposes utilisation', () => {
    const c = make();
    setInputValue(c.gpu, sampleGpu);
    expect(c.gpuLabel()).toBe('33%');
    expect(c.gpuSublabel()).toBe('RTX 4090');
    expect(c.gpuNeutral()).toBe(false);
  });

  it('shows an em-dash + neutral flag when the GPU reports no utilisation (Apple)', () => {
    const c = make();
    setInputValue(c.gpu, sampleAppleGpu);
    expect(c.gpuLabel()).toBe('—');
    expect(c.gpuSublabel()).toBe('M3 Max');
    expect(c.gpuNeutral()).toBe(true);
    expect(c.gpuRatio()).toBe(0);
  });

  it('clamps the CPU ratio above 100 % to 1', () => {
    const c = make();
    setInputValue(c.cpu, { percent: 150, cores: 1, model: '' });
    expect(c.cpuRatio()).toBe(1);
  });

  it('clamps the CPU ratio below 0 % to 0', () => {
    const c = make();
    setInputValue(c.cpu, { percent: -10, cores: 1, model: '' });
    expect(c.cpuRatio()).toBe(0);
  });

  it('handles zero-total memory as 0 ratio instead of NaN', () => {
    const c = make();
    setInputValue(c.memory, { ...sampleMem, totalBytes: 0 });
    expect(c.memoryRatio()).toBe(0);
  });

  it('clamps the GPU ratio above 100 % to 1', () => {
    const c = make();
    setInputValue(c.gpu, { vendor: 'nvidia', percent: 999 });
    expect(c.gpuRatio()).toBe(1);
  });

  it('surfaces VRAM used/total independently of utilisation (issue #224)', () => {
    // The whole point: a card can read ~0% util while ~all VRAM is held by a
    // co-tenant, and only the memory line reveals it.
    const c = make();
    setInputValue(c.gpu, {
      vendor: 'nvidia',
      percent: 3,
      name: 'Quadro P4000',
      memoryUsedBytes: 7.45 * 1024 ** 3,
      memoryTotalBytes: 8 * 1024 ** 3,
    });
    expect(c.gpuLabel()).toBe('3%');
    expect(c.gpuMemoryLabel()).toBe('7.5 GB / 8.0 GB');
    // The fill still tracks utilisation (that's what the % label says).
    expect(c.gpuRatio()).toBeCloseTo(0.03, 5);
    expect(c.gpuNeutral()).toBe(false);
  });

  it('falls back to the VRAM ratio for the fill when utilisation is not reported', () => {
    const c = make();
    setInputValue(c.gpu, {
      vendor: 'nvidia',
      memoryUsedBytes: 4 * 1024 ** 3,
      memoryTotalBytes: 8 * 1024 ** 3,
    });
    expect(c.gpuLabel()).toBe('—'); // no utilisation number
    expect(c.gpuRatio()).toBe(0.5); // …but the bar reflects VRAM
    expect(c.gpuNeutral()).toBe(false); // not neutral — memory is meaningful
  });

  it('has no VRAM line when the vendor reports none', () => {
    const c = make();
    setInputValue(c.gpu, sampleGpu);
    expect(c.gpuMemoryLabel()).toBe('');
  });

  it('shares the green→red colour palette with disk-pill (hsl 140 → 0)', () => {
    const lo = make();
    setInputValue(lo.cpu, { percent: 0, cores: 1, model: '' });
    expect(lo.cpuFill()).toBe('hsl(140, 70%, 45%)');
    const hi = make();
    setInputValue(hi.cpu, { percent: 100, cores: 1, model: '' });
    expect(hi.cpuFill()).toBe('hsl(0, 70%, 45%)');
  });
});

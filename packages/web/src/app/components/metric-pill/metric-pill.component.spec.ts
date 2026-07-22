import { ɵSIGNAL as SIGNAL } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { MetricPillComponent } from './metric-pill.component';
import type { CpuSnapshot, GpuSnapshot, MemorySnapshot } from '../../services/api/api-types';

/**
 * The web JIT vitest harness can't drive Angular signal input()s the normal
 * way (see disk-pill.component.spec.ts). We mutate the underlying input
 * signal directly and exercise each computed. Two consecutive writes to the
 * same input signal don't reliably re-publish downstream computeds in the
 * harness, so each scenario creates a fresh component instance.
 *
 * DOM rendering is covered by the existing e2e + AdminComponent integration
 * tests — the unit suite here guards the pure computation rules.
 */
function setInput<T>(inputSignal: () => T, value: T): void {
  (inputSignal as unknown as Record<typeof SIGNAL, { value: T }>)[SIGNAL].value = value;
}

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
    setInput(c.cpu, sampleCpu);
    expect(c.cpuLabel()).toBe('42%');
  });

  it('formats the memory pill label as `${used} / ${total}` and surfaces process RSS', () => {
    const c = make();
    setInput(c.memory, sampleMem);
    expect(c.memoryLabel()).toBe('8.0 GB / 16.0 GB');
    expect(c.memoryProcessLabel()).toBe('412 MB process');
  });

  it('formats the GPU pill label as `${percent}%` when the vendor exposes utilisation', () => {
    const c = make();
    setInput(c.gpu, sampleGpu);
    expect(c.gpuLabel()).toBe('33%');
    expect(c.gpuSublabel()).toBe('RTX 4090');
    expect(c.gpuNeutral()).toBe(false);
  });

  it('shows an em-dash + neutral flag when the GPU reports no utilisation (Apple)', () => {
    const c = make();
    setInput(c.gpu, sampleAppleGpu);
    expect(c.gpuLabel()).toBe('—');
    expect(c.gpuSublabel()).toBe('M3 Max');
    expect(c.gpuNeutral()).toBe(true);
    expect(c.gpuRatio()).toBe(0);
  });

  it('clamps the CPU ratio above 100 % to 1', () => {
    const c = make();
    setInput(c.cpu, { percent: 150, cores: 1, model: '' });
    expect(c.cpuRatio()).toBe(1);
  });

  it('clamps the CPU ratio below 0 % to 0', () => {
    const c = make();
    setInput(c.cpu, { percent: -10, cores: 1, model: '' });
    expect(c.cpuRatio()).toBe(0);
  });

  it('handles zero-total memory as 0 ratio instead of NaN', () => {
    const c = make();
    setInput(c.memory, { ...sampleMem, totalBytes: 0 });
    expect(c.memoryRatio()).toBe(0);
  });

  it('clamps the GPU ratio above 100 % to 1', () => {
    const c = make();
    setInput(c.gpu, { vendor: 'nvidia', percent: 999 });
    expect(c.gpuRatio()).toBe(1);
  });

  it('shares the green→red colour palette with disk-pill (hsl 140 → 0)', () => {
    const lo = make();
    setInput(lo.cpu, { percent: 0, cores: 1, model: '' });
    expect(lo.cpuFill()).toBe('hsl(140, 70%, 45%)');
    const hi = make();
    setInput(hi.cpu, { percent: 100, cores: 1, model: '' });
    expect(hi.cpuFill()).toBe('hsl(0, 70%, 45%)');
  });
});

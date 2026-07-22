import { Component, computed, input } from '@angular/core';
import { diskFillColor, formatBytes, formatMb } from '../../lib/usage-pill';
import type { CpuSnapshot, GpuSnapshot, MemorySnapshot } from '../../services/api/api-types';

/**
 * One compact usage pill on the Admin → System "Metrics" row. Mirrors the
 * existing `DiskPillComponent` idiom (rounded pill, fill bar that runs
 * green→red as the ratio climbs, `tabular-nums` value) so the Admin reads
 * as a uniform dashboard. Each instance renders CPU / memory / GPU based
 * on the matching `input()` slot — the CPU + GPU snapshot inputs carry
 * percentages; memory takes both `usedBytes` and `totalBytes` for the
 * ratio + a `processRssBytes` line that surfaces NicotinD's own footprint.
 *
 * The GPU pill gracefully hides when the metric is null (no vendor CLI on
 * the box) — `@if` in the parent template suppresses the @Component.
 */
@Component({
  selector: 'app-metric-pill',
  standalone: true,
  templateUrl: './metric-pill.component.html',
})
export class MetricPillComponent {
  readonly cpu = input<CpuSnapshot | null>(null);
  readonly memory = input<MemorySnapshot | null>(null);
  readonly gpu = input<GpuSnapshot | null>(null);

  // --- memoised ratio/fill/label per slot -------------------------------------

  readonly cpuRatio = computed(() => {
    const c = this.cpu();
    if (!c) return 0;
    return Math.min(1, Math.max(0, c.percent / 100));
  });
  readonly cpuFill = computed(() => diskFillColor(this.cpuRatio()));
  readonly cpuLabel = computed(() => {
    const c = this.cpu();
    return c ? `${Math.round(c.percent)}%` : '—';
  });

  readonly memoryLabel = computed(() => {
    const m = this.memory();
    return m ? `${formatBytes(m.usedBytes)} / ${formatBytes(m.totalBytes)}` : '—';
  });
  readonly memoryProcessLabel = computed(() => {
    const m = this.memory();
    return m ? `${formatMb(m.processRssBytes)} process` : '';
  });
  readonly memoryRatio = computed(() => {
    const m = this.memory();
    return m && m.totalBytes > 0 ? Math.min(1, Math.max(0, m.usedBytes / m.totalBytes)) : 0;
  });
  readonly memoryFill = computed(() => diskFillColor(this.memoryRatio()));

  readonly gpuRatio = computed(() => {
    const g = this.gpu();
    if (!g || g.percent === undefined) return 0;
    return Math.min(1, Math.max(0, g.percent / 100));
  });
  readonly gpuFill = computed(() => diskFillColor(this.gpuRatio()));
  readonly gpuLabel = computed(() => {
    const g = this.gpu();
    if (!g) return '—';
    return g.percent !== undefined ? `${Math.round(g.percent)}%` : '—';
  });
  readonly gpuSublabel = computed(() => this.gpu()?.name ?? '');
  /** GPU has no exposed % (Apple) → render the fill as neutral grey. */
  readonly gpuNeutral = computed(() => {
    const g = this.gpu();
    return !!g && g.percent === undefined;
  });
}

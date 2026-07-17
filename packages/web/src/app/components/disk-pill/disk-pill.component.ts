import { Component, input, computed } from '@angular/core';
import { formatBytes, usedRatio, diskFillColor } from '../../lib/disk-usage';

/**
 * Compact storage pill for the Downloads header: shows "used / total" (e.g.
 * "95 GB / 969 GB") over a progress fill that runs green → red as the disk
 * fills. All maths live in the pure lib/disk-usage helpers so they're unit
 * testable without driving the input() signals.
 */
@Component({
  selector: 'app-disk-pill',
  standalone: true,
  templateUrl: './disk-pill.component.html',
})
export class DiskPillComponent {
  readonly used = input.required<number>();
  readonly total = input.required<number>();

  readonly ratio = computed(() => usedRatio(this.used(), this.total()));
  readonly fillPercent = computed(() => this.ratio() * 100);
  readonly fillColor = computed(() => diskFillColor(this.ratio()));
  readonly label = computed(() => `${formatBytes(this.used())} / ${formatBytes(this.total())}`);
}

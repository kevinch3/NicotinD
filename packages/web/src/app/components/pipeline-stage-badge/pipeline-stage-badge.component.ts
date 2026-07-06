import { Component, input, computed } from '@angular/core';
import type { PipelineStage } from '@nicotind/core';
import { stageBadge } from '../../lib/pipeline-stage';

/**
 * Small presentational chip for a pipeline stage (queued → downloading →
 * organizing → scanning → done / error). Tone → theme classes are mapped here;
 * the label/tone logic lives in the pure `lib/pipeline-stage.ts` so it's unit
 * testable without driving the input() signal.
 */
@Component({
  selector: 'app-pipeline-stage-badge',
  standalone: true,
  template: `
    <span
      class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
      [class]="toneClass()"
      [attr.data-stage]="stage()"
      data-testid="stage-badge"
    >
      @if (badge().tone === 'active') {
        <span class="w-1.5 h-1.5 rounded-full bg-current animate-pulse"></span>
      }
      {{ badge().label }}
    </span>
  `,
})
export class PipelineStageBadgeComponent {
  readonly stage = input.required<PipelineStage>();

  readonly badge = computed(() => stageBadge(this.stage()));

  readonly toneClass = computed(() => {
    switch (this.badge().tone) {
      case 'active':
        return 'status-progress';
      case 'error':
        return 'status-error';
      case 'done':
        return 'status-done';
      default:
        return 'bg-theme-surface-2 text-theme-muted';
    }
  });
}

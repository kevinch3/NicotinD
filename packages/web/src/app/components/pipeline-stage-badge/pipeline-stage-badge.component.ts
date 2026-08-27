import { Component, input, computed, inject } from '@angular/core';
import type { PipelineStage } from '@nicotind/core';
import { stageBadge } from '../../lib/pipeline-stage';
import { TranslateService } from '../../services/translate.service';

/**
 * Small presentational chip for a pipeline stage (queued → downloading →
 * organizing → scanning → done / error). Tone → theme classes are mapped here;
 * the label/tone logic lives in the pure `lib/pipeline-stage.ts` so it's unit
 * testable without driving the input() signal.
 */
@Component({
  selector: 'app-pipeline-stage-badge',
  standalone: true,
  templateUrl: './pipeline-stage-badge.component.html',
})
export class PipelineStageBadgeComponent {
  readonly stage = input.required<PipelineStage>();

  private readonly i18n = inject(TranslateService);

  readonly badge = computed(() => stageBadge(this.stage()));
  /** Translated label, falling back to the map's English (#664 lands the rest). */
  readonly label = computed(() => {
    const badge = this.badge();
    const translated = this.i18n.t(badge.key);
    return translated === badge.key ? badge.label : translated;
  });

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

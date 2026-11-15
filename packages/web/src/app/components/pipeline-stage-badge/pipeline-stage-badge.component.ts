import { Component, input, computed, inject } from '@angular/core';
import type { PipelineStage } from '@nicotind/core';
import { partialBadge, stageBadge, stageLabel } from '../../lib/pipeline-stage';
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
  /** A done card with tracks missing reads Partial, in the warning tone (#1939). */
  readonly partial = input(false);

  private readonly i18n = inject(TranslateService);

  readonly badge = computed(() =>
    this.partial() && this.stage() === 'done' ? partialBadge() : stageBadge(this.stage()),
  );
  readonly label = computed(() =>
    this.partial() && this.stage() === 'done'
      ? this.i18n.t(partialBadge().key)
      : stageLabel(this.stage(), (key) => this.i18n.t(key)),
  );

  readonly toneClass = computed(() => {
    switch (this.badge().tone) {
      case 'active':
        return 'status-progress';
      case 'error':
        return 'status-error';
      case 'done':
        return 'status-done';
      case 'warn':
        return 'status-warn';
      default:
        return 'bg-theme-surface-2 text-theme-muted';
    }
  });
}

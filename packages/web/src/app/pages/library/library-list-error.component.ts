import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * Shown in place of a library tab's grid when its fetch failed (#1059).
 *
 * The four whole-library tabs used to swallow fetch errors and leave the
 * previous list on screen. With a filter active that is not merely unhelpful,
 * it is wrong: the rows contradict the filter chips above them, which is
 * exactly how the quadratic-filter timeout in #1055 was reported as "the
 * filter returns the same results". A list we could not load says so.
 */
@Component({
  selector: 'app-library-list-error',
  standalone: true,
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="flex flex-col items-center gap-3 py-20 text-center"
      role="alert"
      [attr.data-testid]="'library-list-error-' + tab()"
    >
      <p class="text-theme-primary text-sm">{{ 'library.listErrorTitle' | t }}</p>
      <p class="text-theme-muted text-xs max-w-sm">{{ 'library.listErrorBody' | t }}</p>
      <button
        type="button"
        class="px-3 py-1.5 text-sm rounded-lg bg-theme-surface-2 text-theme-primary focus:ring-1 focus:ring-[var(--theme-accent)]"
        [attr.data-testid]="'library-list-retry-' + tab()"
        (click)="retry.emit()"
      >
        {{ 'library.listRetry' | t }}
      </button>
    </div>
  `,
})
export class LibraryListErrorComponent {
  /** Which tab failed — only used to make the testids addressable per tab. */
  readonly tab = input.required<'artists' | 'singles' | 'compilations' | 'genres'>();
  readonly retry = output<void>();
}

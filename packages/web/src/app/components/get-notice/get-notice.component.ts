import { Component, input, output } from '@angular/core';
import { TranslatePipe } from '../../pipes/translate.pipe';

export type NoticeTone = 'error' | 'warn' | 'info';

/**
 * One notice on the Get page, in the theme's status colours. Actions are
 * projected, so a notice carries the button that resolves it (Retry, Load
 * discography) instead of the page stacking a banner and a button apart.
 */
@Component({
  selector: 'app-get-notice',
  standalone: true,
  imports: [TranslatePipe],
  host: { class: 'block' },
  template: `
    <div
      [attr.role]="tone() === 'error' ? 'alert' : 'status'"
      [attr.data-tone]="tone()"
      class="px-4 py-3 rounded-lg flex flex-wrap items-center gap-x-3 gap-y-2"
      [class]="toneClass[tone()]"
    >
      <div class="flex-1 min-w-0 text-sm space-y-1"><ng-content /></div>
      <ng-content select="[noticeAction]" />
      @if (dismissible()) {
        <button
          type="button"
          data-testid="notice-dismiss"
          (click)="dismiss.emit()"
          [attr.aria-label]="'getNotice.dismiss' | t"
          class="shrink-0 text-lg leading-none font-medium opacity-80 hover:opacity-100"
        >
          ×
        </button>
      }
    </div>
  `,
})
export class GetNoticeComponent {
  readonly tone = input<NoticeTone>('info');
  readonly dismissible = input(false);
  readonly dismiss = output<void>();

  protected readonly toneClass: Record<NoticeTone, string> = {
    error: 'status-error',
    warn: 'status-warn',
    info: 'status-progress',
  };
}

import { Component, input, output, signal, computed } from '@angular/core';
import type { DownloadItem } from '../../lib/download-groups';
import { methodBadge } from '../../lib/acquisition-method';
import { PipelineStageBadgeComponent } from '../pipeline-stage-badge/pipeline-stage-badge.component';

/** Relative "Xm ago" from a ms timestamp. */
function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Yesterday' : `${days}d ago`;
}

/**
 * One row in the unified Downloads feed. Renders the four facets the user asked
 * for — how (method badge), what stage, when (started), where (storage path,
 * tucked behind a toggle) — plus retry / cancel / remove controls that emit to
 * the parent, which dispatches by `item.kind`.
 */
@Component({
  selector: 'app-download-item',
  standalone: true,
  imports: [PipelineStageBadgeComponent],
  template: `
    <div
      class="flex items-center gap-3 md:gap-4 px-3 md:px-4 py-3 rounded-lg bg-theme-surface/50 border border-theme min-w-0"
      data-testid="download-item"
      [attr.data-method]="item().method"
      [attr.data-stage]="item().stage"
      [attr.data-kind]="item().kind"
    >
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 min-w-0">
          <span
            class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide bg-theme-surface-2 text-theme-muted flex-shrink-0"
            data-testid="method-badge"
          >
            <span translate="no">{{ badge().glyph }}</span>{{ badge().label }}
          </span>
          <p class="text-sm text-theme-primary truncate" data-testid="download-title">
            {{ item().title }}
          </p>
        </div>
        @if (item().subtitle) {
          <p class="text-xs text-theme-secondary truncate mt-0.5">{{ item().subtitle }}</p>
        }
        <div class="flex items-center gap-2 mt-1 flex-wrap">
          <app-pipeline-stage-badge [stage]="item().stage" />
          @if (item().progress; as p) {
            <span class="text-xs text-theme-muted">{{ p.done }} of {{ p.total }}</span>
          }
          @if (item().startedAt) {
            <span class="text-xs text-theme-muted">· {{ startedAgo() }}</span>
          }
          @if (item().storagePath) {
            <button
              type="button"
              class="text-xs text-theme-muted hover:text-theme-secondary transition underline decoration-dotted"
              (click)="showPath.set(!showPath())"
            >
              {{ showPath() ? 'Hide path' : 'Where?' }}
            </button>
          }
        </div>
        @if (showPath() && item().storagePath) {
          <p class="text-xs text-theme-muted mt-1 break-all" data-testid="storage-path">
            {{ item().storagePath }}
          </p>
        }
        @if (item().error) {
          <p class="text-xs text-red-400/70 mt-1 truncate" [title]="item().error">
            {{ item().error }}
          </p>
        }
      </div>

      <!-- Progress -->
      @if (item().percent !== undefined) {
        <div class="w-16 md:w-28 flex-shrink-0">
          <div class="h-1.5 bg-theme-surface-2 rounded-full overflow-hidden">
            <div
              class="h-full bg-blue-500 rounded-full transition-all duration-500"
              [style.width.%]="item().percent"
            ></div>
          </div>
          <p class="text-xs text-blue-400 text-right mt-1">{{ item().percent }}%</p>
        </div>
      }

      <!-- Actions -->
      @if (item().canRetry) {
        <button
          (click)="retry.emit()"
          [disabled]="retrying()"
          class="text-xs px-2 py-1 rounded-md bg-theme-surface-2 text-theme-secondary hover:text-theme-primary transition flex-shrink-0 disabled:opacity-50"
          data-testid="download-retry"
          title="Retry"
        >
          {{ retrying() ? 'Retrying…' : 'Retry' }}
        </button>
      }
      @if (item().canCancel) {
        <button
          (click)="cancel.emit()"
          class="p-1 text-theme-muted hover:text-red-400 transition flex-shrink-0"
          data-testid="download-cancel"
          title="Cancel"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      }
      @if (item().canRemove && !item().canCancel) {
        <button
          (click)="remove.emit()"
          class="p-1 text-theme-muted hover:text-red-400 transition flex-shrink-0"
          data-testid="download-remove"
          title="Dismiss"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      }
    </div>
  `,
})
export class DownloadItemComponent {
  readonly item = input.required<DownloadItem>();
  readonly retrying = input(false);

  readonly retry = output<void>();
  readonly cancel = output<void>();
  readonly remove = output<void>();

  readonly showPath = signal(false);

  readonly badge = computed(() => methodBadge(this.item().method));

  startedAgo(): string {
    const at = this.item().startedAt;
    return at ? timeAgo(at) : '';
  }
}

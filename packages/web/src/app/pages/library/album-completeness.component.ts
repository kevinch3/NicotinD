import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { LibraryApiService } from '../../services/api/library-api.service';
import type { AlbumCompleteness, CompleteAlbumResponse } from '../../services/api/api-types';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { TranslateService } from '../../services/translate.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';

type Outcome = CompleteAlbumResponse['outcome'];

const OUTCOME_KIND: Record<Outcome, 'info' | 'success' | 'error'> = {
  enqueued: 'success',
  'already-complete': 'info',
  'in-flight': 'info',
  'no-candidate': 'info',
  'slskd-unavailable': 'error',
  'enqueue-failed': 'error',
};

/**
 * The album page's "incomplete — N of M tracks" badge and, for curators, the
 * "Complete this album" action (issue #737). The badge is the health report's
 * CONFIRMED completeness row for this album, read through the album-scoped
 * endpoint — never the whole report. The action hunts only the missing tracks
 * (the MCP `complete_album` path) and is disabled under the acquisition
 * kill-switch. → docs/library-audit.md "Album page badge".
 */
@Component({
  selector: 'app-album-completeness',
  imports: [TranslatePipe, TvNavItemDirective],
  template: `
    @if (confirmed(); as c) {
      <div class="flex flex-wrap items-center justify-center sm:justify-start gap-2 mt-2">
        <span
          data-testid="album-incomplete-badge"
          class="px-2 py-0.5 rounded-md text-xs status-warn"
        >
          {{ 'album.incompleteBadge' | t: { owned: c.owned, expected: c.expected } }}
        </span>
        @if (auth.canCurate()) {
          <button
            appTvNavItem
            type="button"
            data-testid="album-complete-action"
            (click)="complete()"
            [disabled]="actionDisabled()"
            [attr.title]="auth.canAcquire() ? null : ('album.completeDisabled' | t)"
            class="px-3 py-1 rounded-lg text-xs bg-theme-surface-2 text-theme-muted hover:bg-theme-hover transition disabled:opacity-50"
          >
            {{ (busy() ? 'album.completeBusy' : 'album.completeAction') | t }}
          </button>
        }
      </div>
    }
  `,
})
export class AlbumCompletenessComponent {
  private api = inject(LibraryApiService);
  readonly auth = inject(AuthService);
  private toast = inject(ToastService);
  private i18n = inject(TranslateService);

  // Not input.required: the JIT spec harness would throw NG0950 in the host (docs/web-ui.md).
  readonly albumId = input('');
  /** Bumped by the page when this album changes (tracks landed) — re-reads. */
  readonly reloadKey = input(0);

  private readonly state = signal<AlbumCompleteness | null>(null);
  readonly confirmed = computed(() => {
    const s = this.state();
    return s && s.albumId === this.albumId() ? s.confirmed : null;
  });
  readonly busy = signal(false);
  /** Set once a hunt is running for this album, so a second tap is not offered. */
  private readonly requested = signal(false);
  readonly actionDisabled = computed(
    () => !this.auth.canAcquire() || this.busy() || this.requested(),
  );

  private readonly load = effect(() => {
    const id = this.albumId();
    this.reloadKey();
    this.requested.set(false);
    if (!id) return;
    firstValueFrom(this.api.getAlbumCompleteness(id)).then(
      (s) => this.state.set(s),
      () => this.state.set(null), // a failed read hides the badge; it is advisory
    );
  });

  async complete(): Promise<void> {
    if (this.actionDisabled()) return;
    this.busy.set(true);
    try {
      const res = await firstValueFrom(this.api.completeAlbum(this.albumId()));
      if (res.outcome === 'enqueued' || res.outcome === 'in-flight') this.requested.set(true);
      const kind = OUTCOME_KIND[res.outcome] ?? 'info';
      const message = this.i18n.t(`album.completeOutcome.${res.outcome}`);
      // A failure's detail is the addon's own error — what tells an outage from a rejection.
      this.toast.show({
        kind,
        message: kind === 'error' && res.detail ? `${message} — ${res.detail}` : message,
      });
    } catch {
      this.toast.show({ kind: 'error', message: this.i18n.t('album.completeFailed') });
    } finally {
      this.busy.set(false);
    }
  }
}

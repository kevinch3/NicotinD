import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { AuthService } from '../../services/auth.service';
import { SystemApiService } from '../../services/api/system-api.service';

/**
 * The first-run empty state shared by Home and Library (#1739). A fresh install
 * with nothing in its music folder used to show a field of radio tiles that
 * played nothing, or a bare "No songs found.", with no word on where music goes.
 * This says where (the path, to admins, since it is the server's filesystem),
 * offers the scan right here rather than three panels deep in Admin, and links
 * to Add for the users who can use it.
 */
@Component({
  selector: 'app-empty-library',
  standalone: true,
  imports: [TranslatePipe, RouterLink],
  template: `
    <div class="mx-auto max-w-md text-center text-theme-muted" data-testid="empty-library">
      <p class="text-base font-medium text-theme-secondary">{{ 'library.empty.title' | t }}</p>
      <p class="mt-2 text-sm">{{ 'library.empty.body' | t }}</p>
      @if (musicDir(); as dir) {
        <p class="mt-3 text-xs">
          {{ 'library.empty.pathLabel' | t }}
          <code class="break-all text-theme-secondary" data-testid="empty-library-path">{{
            dir
          }}</code>
        </p>
      }
      <div class="mt-5 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          data-testid="empty-library-scan"
          class="rounded-full border border-theme px-4 py-2 text-sm font-medium text-theme-secondary transition hover:text-theme-primary disabled:cursor-wait disabled:opacity-50"
          [disabled]="scanState() === 'scanning'"
          [attr.aria-busy]="scanState() === 'scanning'"
          (click)="scan()"
        >
          {{ (scanState() === 'scanning' ? 'library.empty.scanning' : 'library.empty.scan') | t }}
        </button>
        @if (auth.canImport()) {
          <a
            routerLink="/get"
            data-testid="empty-library-add"
            class="rounded-full bg-theme-accent px-4 py-2 text-sm font-medium text-theme-on-accent transition hover:opacity-90"
            >{{ 'library.empty.add' | t }}</a
          >
        }
      </div>
      @if (scanState() === 'started' || scanState() === 'failed') {
        <p class="mt-3 text-xs" role="status" data-testid="empty-library-scan-status">
          {{
            (scanState() === 'started' ? 'library.empty.scanStarted' : 'library.empty.scanFailed')
              | t
          }}
        </p>
      }
    </div>
  `,
})
export class EmptyLibraryComponent {
  readonly auth = inject(AuthService);
  private readonly system = inject(SystemApiService);

  readonly musicDir = signal<string | null>(null);
  readonly scanState = signal<'idle' | 'scanning' | 'started' | 'failed'>('idle');

  constructor() {
    if (this.auth.isAdmin()) {
      this.system.getLibraryLocation().subscribe({
        next: (r) => this.musicDir.set(r.musicDir),
        // An older server without the route: the rest of the state still helps.
        error: () => {},
      });
    }
  }

  async scan(): Promise<void> {
    if (this.scanState() === 'scanning') return;
    this.scanState.set('scanning');
    try {
      await firstValueFrom(this.system.triggerScan());
      this.scanState.set('started');
    } catch {
      this.scanState.set('failed');
    }
  }
}

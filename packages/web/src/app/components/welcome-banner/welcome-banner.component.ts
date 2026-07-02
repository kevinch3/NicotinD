import { Component, inject, signal } from '@angular/core';
import { AuthService } from '../../services/auth.service';
import { AuthApiService } from '../../services/api/auth-api.service';

@Component({
  selector: 'app-welcome-banner',
  template: `
    @if (show()) {
      <div
        class="flex items-center justify-between gap-4 px-4 py-3 border-b"
        style="background: var(--theme-surface); border-color: var(--theme-border);"
      >
        <span class="text-sm" style="color: var(--theme-text-secondary);">
          Welcome! Your admin has set up your account. Browse the library, search Soulseek, or start playing music.
        </span>
        <button
          (click)="dismiss()"
          class="shrink-0 rounded px-3 py-1 text-sm font-medium transition-opacity hover:opacity-80"
          style="background: var(--theme-accent); color: #fff;"
        >
          Got it
        </button>
      </div>
    }
  `,
})
export class WelcomeBannerComponent {
  private auth = inject(AuthService);
  private api = inject(AuthApiService);

  readonly show = signal(false);

  constructor() {
    const role = this.auth.role();
    const dismissed = this.auth.welcomeDismissed();
    this.show.set(role === 'user' && !dismissed);
  }

  dismiss(): void {
    this.api.dismissWelcome().subscribe({
      next: () => {
        this.auth.welcomeDismissed.set(true);
        this.show.set(false);
      },
      error: () => {},
    });
  }
}

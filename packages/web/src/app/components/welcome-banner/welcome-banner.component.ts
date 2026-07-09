import { Component, inject, signal } from '@angular/core';
import { AuthService } from '../../services/auth.service';
import { AuthApiService } from '../../services/api/auth-api.service';

@Component({
  selector: 'app-welcome-banner',
  templateUrl: './welcome-banner.component.html',
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

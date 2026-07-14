import { Component, inject, effect } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { SetupService } from './services/setup.service';
import { AuthService } from './services/auth.service';
import { RemotePlaybackService } from './services/remote-playback.service';
import { PresenceService } from './services/presence.service';
import { ToastOutletComponent } from './components/toast-outlet/toast-outlet.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastOutletComponent],
  template: `<router-outlet /><app-toast-outlet />`,
})
export class App {
  private setup = inject(SetupService);
  private auth = inject(AuthService);
  private router = inject(Router);
  private remotePlayback = inject(RemotePlaybackService);
  private presence = inject(PresenceService);

  constructor() {
    // Initialize remote playback WebSocket subscriptions
    this.remotePlayback.initialize();

    // Start presence heartbeats (admin-only visibility of who is active)
    this.presence.initialize();

    // Redirect to setup if needed, or to the library (Songs → offline downloads)
    // when offline (runs after APP_INITIALIZER completes).
    effect(() => {
      if (!this.setup.checked()) return;
      if (this.setup.isOffline() && this.auth.token()) {
        this.router.navigate(['/library']);
      } else if (this.setup.status()?.needsSetup) {
        this.router.navigate(['/setup']);
      }
    });
  }
}

import { Component, inject, effect } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { SetupService } from './services/setup.service';
import { AuthService } from './services/auth.service';
import { RemotePlaybackService } from './services/remote-playback.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `<router-outlet />`,
})
export class App {
  private setup = inject(SetupService);
  private auth = inject(AuthService);
  private router = inject(Router);
  private remotePlayback = inject(RemotePlaybackService);

  constructor() {
    // Initialize remote playback WebSocket subscriptions
    this.remotePlayback.initialize();

    // Redirect to setup if needed (runs after APP_INITIALIZER completes)
    effect(() => {
      if (this.setup.checked() && this.setup.status()?.needsSetup) {
        this.router.navigate(['/setup']);
      }
    });
  }
}

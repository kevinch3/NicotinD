import { Component, inject, effect } from '@angular/core';
import type { Subscription } from 'rxjs';
import { Router, RouterOutlet } from '@angular/router';
import { SetupService } from './services/setup.service';
import { RemotePlaybackService } from './services/remote-playback.service';
import { PresenceService } from './services/presence.service';
import { KeyboardShortcutsService } from './services/keyboard-shortcuts.service';
import { BackButtonService } from './services/native/back-button.service';
import { TvChannelsService } from './services/native/tv-channels.service';
import { UpdateService } from './services/update.service';
import { ToastOutletComponent } from './components/toast-outlet/toast-outlet.component';
import { DesktopTitleBarOverlayComponent } from './components/desktop-title-bar-overlay/desktop-title-bar-overlay.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastOutletComponent, DesktopTitleBarOverlayComponent],
  // The overlay self-gates (Linux/Win Electron + no shell header active),
  // so it's a no-op everywhere else — see desktop-title-bar-overlay.
  template: `<app-desktop-title-bar-overlay /><router-outlet /><app-toast-outlet />`,
})
export class App {
  private setup = inject(SetupService);
  private router = inject(Router);
  private remotePlayback = inject(RemotePlaybackService);
  private presence = inject(PresenceService);
  private keyboardShortcuts = inject(KeyboardShortcutsService);
  private backButton = inject(BackButtonService);
  private tvChannels = inject(TvChannelsService);
  private updates = inject(UpdateService);

  // `App` is the root component (mounted once, never destroyed), so this
  // subscription outlives the app regardless — kept as a field rather than
  // discarded so a future refactor needing cleanup has it structurally
  // available without re-deriving it.
  private readonly keyboardShortcutsSub: Subscription;

  constructor() {
    // Initialize remote playback WebSocket subscriptions
    this.remotePlayback.initialize();

    // Start presence heartbeats (admin-only visibility of who is active)
    this.presence.initialize();

    // Global keyboard/TV-remote shortcuts (Space/K = play-pause for now).
    this.keyboardShortcutsSub = this.keyboardShortcuts.initialize();

    // Android hardware Back: overlays first, then history, exit at home (#394).
    this.backButton.initialize();

    // Google TV Play Next + Assistant voice playback (Android TV only).
    this.tvChannels.initialize();

    // Background PWA updates (#1126): the resume/periodic checks an installed
    // standalone app never gets from a navigation, and the auto-apply that
    // replaces a banner nobody presses. A no-op wherever the service worker is
    // disabled (dev, the Capacitor shells, Electron). Started here rather than
    // in the initializer because `UpdateService` reads `APP_VERSION` from
    // app.config, and app.config importing it back would be a module cycle.
    this.updates.start();

    // Redirect to setup if needed (runs after APP_INITIALIZER completes).
    //
    // Going offline used to navigate to /library, because home was a wall of
    // dead server-backed shelves. The mosaic now fills with the device's
    // downloaded tracks instead, so the redirect would only yank the listener
    // off the page they were on the moment their train enters a tunnel.
    effect(() => {
      if (!this.setup.checked()) return;
      if (this.setup.status()?.needsSetup) {
        this.router.navigate(['/setup']);
      }
    });
  }
}

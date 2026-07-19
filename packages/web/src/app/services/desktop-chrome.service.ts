import { Injectable, signal } from '@angular/core';

/**
 * Coordinates who owns the desktop window chrome on Linux/Windows Electron
 * (frameless `frame: false` windows draw no OS title bar at all).
 *
 * The authed app shell's header (`LayoutComponent`) doubles as the drag
 * region + window-control bar, but routes outside the shell (setup, login,
 * server picker, share view) render no header — without a fallback the
 * first-run window would be undraggable and unclosable. `LayoutComponent`
 * flips `shellHeaderActive` on init/destroy; `DesktopTitleBarOverlayComponent`
 * (mounted once in the app root) shows a fixed overlay title bar only while
 * no shell header is active, so the two never double-render.
 */
@Injectable({ providedIn: 'root' })
export class DesktopChromeService {
  readonly shellHeaderActive = signal(false);
}

import { Component, computed, inject } from '@angular/core';
import { DesktopChromeService } from '../../services/desktop-chrome.service';
import { isElectronLinux } from '../../lib/platform';
import { DesktopWindowControlsComponent } from '../desktop-window-controls/desktop-window-controls.component';

/**
 * Fallback title bar for the frameless desktop window (Linux/Windows
 * Electron) on routes that render OUTSIDE the app shell — setup, login,
 * server picker, share view. Those pages have no `LayoutComponent` header,
 * so without this the first-run window would have no drag region and no
 * min/max/close controls at all (caught by the packaged smoke test, which
 * lands on `/setup` against a fresh data dir).
 *
 * Mounted once in the app root; visible only while `isElectronLinux()` and
 * no shell header is active (`DesktopChromeService.shellHeaderActive`), so
 * it never double-renders with the shell's own chrome bar. The strip is a
 * transparent fixed overlay — the pages underneath are centered layouts,
 * so nothing interactive sits in the top strip it covers.
 */
@Component({
  selector: 'app-desktop-title-bar-overlay',
  imports: [DesktopWindowControlsComponent],
  template: `
    @if (visible()) {
      <header
        data-electron-title-bar
        data-testid="desktop-title-bar-overlay"
        class="fixed top-0 inset-x-0 z-[100] flex items-center justify-end px-2 py-1 [-webkit-app-region:drag]"
        (dblclick)="onDoubleClick()"
      >
        <app-desktop-window-controls />
      </header>
    }
  `,
})
export class DesktopTitleBarOverlayComponent {
  private chrome = inject(DesktopChromeService);

  readonly visible = computed(() => isElectronLinux() && !this.chrome.shellHeaderActive());

  /** Double-click on the bar toggles maximize (GTK convention), matching
   *  the shell header's behavior. */
  onDoubleClick(): void {
    (globalThis as { window?: { nicotind?: { maximizeToggle?: () => void } } })
      .window?.nicotind?.maximizeToggle?.();
  }
}

import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { isElectronLinux } from '../../lib/platform';

/**
 * In-app min / maximize-toggle / close buttons for the frameless desktop
 * window (Linux/Windows Electron only — macOS keeps its native traffic
 * lights under `titleBarStyle: 'hiddenInset'`, so these would visually
 * duplicate them). Self-gating: renders nothing outside that shell, so
 * hosts (`LayoutComponent`'s header and `DesktopTitleBarOverlayComponent`
 * for the routes outside the shell) can include it unconditionally.
 *
 * Each button is `-webkit-app-region: no-drag` so clicks reach the button
 * instead of dragging the window (the surrounding header is the drag
 * region). IPC goes through the preload bridge on `window.nicotind`; all
 * calls are optional-chained so an older preload is a silent no-op.
 */
@Component({
  selector: 'app-desktop-window-controls',
  // `display: contents` so the (usually empty) host element never occupies
  // a flex-gap slot in the hosting header when the buttons don't render.
  host: { class: 'contents' },
  template: `
    @if (isElectronLinux()) {
      <div class="flex items-center [-webkit-app-region:no-drag]" data-testid="desktop-window-controls">
        <button
          type="button"
          (click)="minimize()"
          data-testid="desktop-window-minimize"
          aria-label="Minimize window"
          class="w-9 h-9 flex items-center justify-center rounded-md text-theme-muted hover:text-theme-primary hover:bg-theme-surface-2/60 transition"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M5 19h14" />
          </svg>
        </button>
        <button
          type="button"
          (click)="toggleMaximize()"
          data-testid="desktop-window-maximize"
          [attr.aria-label]="isMaximized() ? 'Restore window' : 'Maximize window'"
          class="w-9 h-9 flex items-center justify-center rounded-md text-theme-muted hover:text-theme-primary hover:bg-theme-surface-2/60 transition"
        >
          @if (isMaximized()) {
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 8h6v6H4z" />
              <path d="M9 16l4-4h7v7h-7" />
            </svg>
          } @else {
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="5" y="5" width="14" height="14" rx="1" />
            </svg>
          }
        </button>
        <button
          type="button"
          (click)="closeWindow()"
          data-testid="desktop-window-close"
          aria-label="Close window"
          class="w-9 h-9 flex items-center justify-center rounded-md text-theme-muted hover:text-status-error hover:bg-status-error/10 transition"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    }
  `,
})
export class DesktopWindowControlsComponent implements OnInit, OnDestroy {
  readonly isElectronLinux = computed(() => isElectronLinux());

  /** Maximize state mirror — flipped by the `window:maximize-changed`
   *  IPC push from main, used by the maximize-toggle button to swap its
   *  icon between "expand" and "shrink". */
  readonly isMaximized = signal(false);
  private unsubscribeMaximize: (() => void) | null = null;

  /** Toggles OS maximize via the preload bridge; safe to call outside
   *  Electron (no-op when `window.nicotind` is absent). The maximize
   *  state change comes back via `onMaximizeChange` and updates
   *  `isMaximized`. */
  toggleMaximize(): void {
    if (!this.isElectronLinux()) return;
    (globalThis as { window?: { nicotind?: { maximizeToggle?: () => void } } })
      .window?.nicotind?.maximizeToggle?.();
  }

  minimize(): void {
    if (!this.isElectronLinux()) return;
    (globalThis as { window?: { nicotind?: { minimize?: () => void } } }).window?.nicotind?.minimize?.();
  }

  closeWindow(): void {
    if (!this.isElectronLinux()) return;
    (globalThis as { window?: { nicotind?: { close?: () => void } } }).window?.nicotind?.close?.();
  }

  ngOnInit(): void {
    // Maximize-state mirror — only wired on Linux Electron since macOS
    // never renders the buttons. Defense against a missing bridge (older
    // preload / pre-bridge window) keeps it a no-op.
    if (this.isElectronLinux()) {
      const bridge = (globalThis as { window?: { nicotind?: {
        onMaximizeChange?: (cb: (s: { isMaximized: boolean }) => void) => () => void;
      } } }).window?.nicotind;
      this.unsubscribeMaximize = bridge?.onMaximizeChange?.((s) => {
        this.isMaximized.set(!!s?.isMaximized);
      }) ?? null;
    }
  }

  ngOnDestroy(): void {
    this.unsubscribeMaximize?.();
  }
}

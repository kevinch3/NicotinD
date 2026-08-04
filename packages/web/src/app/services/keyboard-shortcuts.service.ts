import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription, fromEvent } from 'rxjs';
import { filter } from 'rxjs/operators';
import { PlayerService } from './player.service';
import { isTvBuild } from '../lib/platform';

/**
 * Global keyboard/TV-remote shortcuts: Space/K (play/pause), J/L (prev/next),
 * M (vocal mute), N (now-playing), ArrowLeft/Right (seek), / (Acquire).
 * Escape-as-back is deferred (needs modal handler arbitration); volume shortcuts
 * won't be added (no volume control in this app).
 * Space is suppressed on natively-activatable elements; K always works outside text fields.
 */
@Injectable({ providedIn: 'root' })
export class KeyboardShortcutsService {
  private static readonly SEEK_STEP_SECONDS = 10;

  private readonly player = inject(PlayerService);
  private readonly router = inject(Router);

  initialize(): Subscription {
    return fromEvent<KeyboardEvent>(window, 'keydown')
      .pipe(filter((e) => !this.isTypingTarget(e.target)))
      .subscribe((e) => this.handle(e));
  }

  private isTypingTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
  }

  private isNativelyActivatable(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (['BUTTON', 'A', 'SELECT', 'SUMMARY'].includes(target.tagName)) return true;
    const role = target.getAttribute('role');
    return role !== null && ['button', 'switch', 'checkbox', 'menuitem', 'tab'].includes(role);
  }

  private handle(event: KeyboardEvent): void {
    // Never claim a modifier chord: Ctrl/Cmd/Alt + a letter or arrow is a
    // browser/OS shortcut (Alt+Arrow = Back/Forward, Ctrl+L = address bar,
    // Cmd+N = new window …) and `event.key` is still the bare letter/arrow, so
    // without this every one of them also fired a player action — and the
    // seek branch's `preventDefault()` actively broke history navigation.
    // Shift is deliberately NOT in the guard: it only uppercases the letter
    // (J/K/L/M/N are already handled) and Shift+/ produces '?', which matches
    // nothing.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const isSpace = event.code === 'Space';
    const isK = event.key === 'k' || event.key === 'K';
    if (isSpace || isK) {
      if (isSpace && this.isNativelyActivatable(event.target)) return;
      event.preventDefault();
      if (this.player.isPlaying()) this.player.pause();
      else this.player.resume();
      return;
    }
    if (event.key === 'j' || event.key === 'J') {
      event.preventDefault();
      this.player.playPrev();
      return;
    }
    if (event.key === 'l' || event.key === 'L') {
      event.preventDefault();
      this.player.playNext();
      return;
    }
    if (event.key === 'm' || event.key === 'M') {
      event.preventDefault();
      this.player.toggleVocalMute();
      return;
    }
    if (event.key === 'n' || event.key === 'N') {
      event.preventDefault();
      this.player.setNowPlayingOpen(true);
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      if (event.defaultPrevented) return; // a D-pad nav group already handled this keypress
      // On a TV build, Left/Right belong to the WebView's spatial focus
      // navigation — preventDefault() here is what cancelled the D-pad focus
      // move and made the whole Now Playing sheet horizontally unnavigable
      // (issue #387). Seeking on TV stays available via the focused seek bar
      // (native <input type=range>) and hardware media keys.
      if (isTvBuild()) return;
      // A focused, closed `<select>` changes its selected option on
      // ArrowLeft/ArrowRight — a preventable default we must not steal (there
      // are `<select>`s in the Library sort dropdowns, Settings, Admin, the
      // track-info sheet …). Deliberately narrower than
      // `isNativelyActivatable`: BUTTON/A/SUMMARY/role=button have no native
      // arrow-key behaviour to protect, and excluding them would disable
      // seeking for the very common case of a focused button (D-pad items are
      // buttons too — inside a nav group the group's own `preventDefault`
      // already makes the branch above bail).
      if (event.target instanceof HTMLElement && event.target.tagName === 'SELECT') return;
      event.preventDefault();
      const delta =
        event.key === 'ArrowRight'
          ? KeyboardShortcutsService.SEEK_STEP_SECONDS
          : -KeyboardShortcutsService.SEEK_STEP_SECONDS;
      this.player.seek(Math.max(0, this.player.currentTime() + delta));
      return;
    }
    if (event.key === '/') {
      event.preventDefault();
      void this.router.navigate(['/acquire']);
      return;
    }
  }
}

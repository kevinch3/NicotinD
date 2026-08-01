import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription, fromEvent } from 'rxjs';
import { filter } from 'rxjs/operators';
import { PlayerService } from './player.service';

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

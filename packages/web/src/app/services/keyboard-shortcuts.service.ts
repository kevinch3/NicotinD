import { Injectable, inject } from '@angular/core';
import { Subscription, fromEvent } from 'rxjs';
import { filter } from 'rxjs/operators';
import { PlayerService } from './player.service';

/**
 * Global keyboard/TV-remote shortcuts. Space and K toggle play/pause; the
 * full shortcut set (next/prev, seek, volume, etc.) is a later phase. Space
 * is suppressed when a focused BUTTON/A/SELECT/SUMMARY element (or an
 * ARIA-role interactive element — button/switch/checkbox/menuitem/tab)
 * would otherwise handle it itself (native Space/Enter activation, or
 * opening a dropdown/toggling a disclosure) — K has no such native meaning
 * on any element so it always toggles play/pause outside a text field.
 */
@Injectable({ providedIn: 'root' })
export class KeyboardShortcutsService {
  private static readonly SEEK_STEP_SECONDS = 10;

  private readonly player = inject(PlayerService);

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
  }
}

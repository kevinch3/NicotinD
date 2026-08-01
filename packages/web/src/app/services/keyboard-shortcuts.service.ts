import { Injectable, inject } from '@angular/core';
import { Subscription, fromEvent } from 'rxjs';
import { filter } from 'rxjs/operators';
import { PlayerService } from './player.service';

/**
 * Global keyboard/TV-remote shortcuts. Space and K toggle play/pause; the
 * full shortcut set (next/prev, seek, volume, etc.) is a later phase. Space
 * is suppressed when a focused BUTTON/A element would otherwise handle it
 * itself (native Space/Enter activation) — K has no such native meaning on
 * any element so it always toggles play/pause outside a text field.
 */
@Injectable({ providedIn: 'root' })
export class KeyboardShortcutsService {
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
    const el = target as HTMLElement | null;
    if (!el) return false;
    return el.tagName === 'BUTTON' || el.tagName === 'A';
  }

  private handle(event: KeyboardEvent): void {
    const isSpace = event.code === 'Space';
    const isK = event.key === 'k' || event.key === 'K';
    if (!isSpace && !isK) return;
    if (isSpace && this.isNativelyActivatable(event.target)) return;
    event.preventDefault();
    if (this.player.isPlaying()) this.player.pause();
    else this.player.resume();
  }
}

import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription, fromEvent } from 'rxjs';
import { PlayerService } from './player.service';
import { LikeService } from './like.service';
import { isTvBuild } from '../lib/platform';
import { isTextEntryTarget } from '../lib/text-entry';
import { keyToAction, type ShortcutEntry } from '../lib/keyboard-shortcuts';

/**
 * Dispatches the keyboard vocabulary in `lib/keyboard-shortcuts.ts` (#1296).
 * Initialized once from `App`, so the TV shell gets its `/player` seek too;
 * everything else in the table is desktop-only. Media keys are not in the
 * table — they stay with the media session. Escape is `BackButtonService`'s.
 */
@Injectable({ providedIn: 'root' })
export class KeyboardShortcutsService {
  /** How long `/` waits for the library's find box after navigating there. */
  private static readonly SEARCH_FOCUS_TIMEOUT_MS = 2000;
  private static readonly SEARCH_FOCUS_POLL_MS = 50;

  private readonly player = inject(PlayerService);
  private readonly likes = inject(LikeService);
  private readonly router = inject(Router);

  /** The `?` sheet. */
  readonly helpOpen = signal(false);

  initialize(): Subscription {
    return fromEvent<KeyboardEvent>(window, 'keydown').subscribe((e) => this.handle(e));
  }

  setHelpOpen(open: boolean): void {
    this.helpOpen.set(open);
  }

  private handle(event: KeyboardEvent): void {
    const entry = keyToAction(event, {
      tvBuild: isTvBuild(),
      tvPlayerRoute: this.router.url.split('?')[0] === '/player',
      textEntry: isTextEntryTarget(event.target),
      activatable: this.isNativelyActivatable(event.target),
    });
    if (!entry) return;
    event.preventDefault();
    this.run(entry);
  }

  private isNativelyActivatable(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (['BUTTON', 'A', 'SELECT', 'SUMMARY'].includes(target.tagName)) return true;
    const role = target.getAttribute('role');
    return role !== null && ['button', 'switch', 'checkbox', 'menuitem', 'tab'].includes(role);
  }

  private run(entry: ShortcutEntry): void {
    switch (entry.id) {
      case 'togglePlay':
        if (this.player.isPlaying()) this.player.pause();
        else this.player.resume();
        return;
      case 'seekBack':
      case 'seekForward':
      case 'tvSeekBack':
      case 'tvSeekForward':
        this.player.seek(Math.max(0, this.player.currentTime() + (entry.seekSeconds ?? 0)));
        return;
      case 'prevTrack':
        this.player.playPrev();
        return;
      case 'nextTrack':
        this.player.playNext();
        return;
      case 'like': {
        const track = this.player.currentTrack();
        if (track) void this.likes.toggle(track.id);
        return;
      }
      case 'radio': {
        const track = this.player.currentTrack();
        if (track) this.player.startRadio(track);
        return;
      }
      case 'toggleNowPlaying':
        this.player.setNowPlayingOpen(!this.player.nowPlayingOpen());
        return;
      case 'queueTab':
        this.player.showNowPlayingPanel('queue');
        return;
      case 'lyricsTab':
        this.player.showNowPlayingPanel('lyrics');
        return;
      case 'vocalMute':
        this.player.toggleVocalMute();
        return;
      case 'search':
        this.focusSearch();
        return;
      case 'help':
        this.helpOpen.update((open) => !open);
        return;
      case 'close':
        return;
    }
  }

  /** The page's own search box when it has one, else the library's find. */
  private focusSearch(): void {
    const local = visibleSearchInput();
    if (local) {
      local.focus();
      return;
    }
    void this.router.navigate(['/library']).then(() => {
      const deadline = Date.now() + KeyboardShortcutsService.SEARCH_FOCUS_TIMEOUT_MS;
      const attempt = (): void => {
        const input = visibleSearchInput();
        if (input) input.focus();
        else if (Date.now() < deadline)
          setTimeout(attempt, KeyboardShortcutsService.SEARCH_FOCUS_POLL_MS);
      };
      attempt();
    });
  }
}

function visibleSearchInput(): HTMLInputElement | null {
  const inputs = document.querySelectorAll<HTMLInputElement>('main input[type="search"]');
  for (const input of Array.from(inputs)) {
    if (!input.disabled && input.getClientRects().length > 0) return input;
  }
  return null;
}

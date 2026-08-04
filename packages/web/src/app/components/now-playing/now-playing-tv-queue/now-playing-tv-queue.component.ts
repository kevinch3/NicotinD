import { AfterViewChecked, Component, ElementRef, inject, input, output } from '@angular/core';
import type { Track } from '../../../services/player.service';
import { registerOverlayCloser } from '../../../services/native/back-button.service';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { TranslatePipe } from '../../../pipes/translate.pipe';

/**
 * The lightweight D-pad queue overlay the TV Next-up chip opens (issue #399).
 * On TV the desktop queue/lyrics panels are template-gated off and only the
 * read-only chip shows the queue head — this overlay is where a remote user
 * jumps to or removes an upcoming track. Rendered under an `@if` by the Now
 * Playing shell, so its lifetime is its open lifetime: the Escape/hardware-
 * Back closer registers once in the constructor (the #398 modal shape).
 */
@Component({
  selector: 'app-now-playing-tv-queue',
  imports: [TvNavGroupDirective, TvNavItemDirective, TranslatePipe],
  templateUrl: './now-playing-tv-queue.component.html',
})
export class NowPlayingTvQueueComponent implements AfterViewChecked {
  readonly queue = input<Track[]>([]);

  readonly jump = output<number>();
  readonly remove = output<number>();
  readonly closed = output<void>();

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private autofocused = false;

  constructor() {
    registerOverlayCloser(() => this.closed.emit());
  }

  /** One-shot autofocus of the first row so the D-pad lands inside the
   *  overlay (the MenuPanel pattern — idempotent, no signal writes). */
  ngAfterViewChecked(): void {
    if (this.autofocused) return;
    const first = this.el.nativeElement.querySelector<HTMLElement>('[data-testid="tv-queue-row"]');
    if (!first) return;
    first.focus();
    this.autofocused = true;
  }
}

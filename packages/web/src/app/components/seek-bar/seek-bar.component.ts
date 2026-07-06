import { Component, computed, input, output, signal } from '@angular/core';
import { seekPercent } from '../../lib/seek-utils';
import {
  bufferedGradient,
  computeBufferedSegments,
  type BufferedRange,
} from '../../lib/buffered-ranges';

/**
 * app-seek-bar — the single seek control behind the desktop mini-player bar, the
 * mobile mini-player edge bar, and the Now Playing sheet.
 *
 * It is a native `<input type="range">`. That choice is deliberate and is the
 * fix for a recurring regression: the previous bespoke `<div>` + pointer-event +
 * `getBoundingClientRect` implementation kept breaking on Firefox desktop
 * (click-to-seek and drag did nothing) while working on touch. A native range
 * delegates click-anywhere, drag, touch, and keyboard (arrow keys) to the
 * browser — uniformly across engines — and renders a real draggable thumb.
 *
 * `seek` fires once, on commit (pointer release / keyboard change), so the
 * parent's active-vs-remote dispatch (set `audio.currentTime` locally, or send a
 * WS `SEEK` to the remote device) runs once rather than spamming on every drag
 * tick. While the user scrubs, the thumb follows the finger from a local
 * `scrub` value so the parent re-feeding `position` can't snap it back.
 */
@Component({
  selector: 'app-seek-bar',
  templateUrl: './seek-bar.component.html',
})
export class SeekBarComponent {
  /** Current playback position, in seconds. */
  readonly position = input(0);
  /** Track duration, in seconds. 0/unknown disables the control. */
  readonly duration = input(0);
  /** Accessible label for the slider. */
  readonly ariaLabel = input('Seek');
  /** Buffered ranges (seconds) painted as a lighter band under the fill. */
  readonly buffered = input<BufferedRange[]>([]);

  /** Committed seek target, in absolute seconds. */
  readonly seek = output<number>();
  /** Live scrub position while dragging, in seconds (for optional preview). */
  readonly preview = output<number>();

  /** Local value while the user is scrubbing; null when following `position`. */
  private readonly scrub = signal<number | null>(null);

  /** Value shown on the input: the scrubbed value while dragging, else position. */
  readonly value = computed(() => this.scrub() ?? this.position());

  /** 0..100 fill percentage for the gradient track. */
  readonly percent = computed(() => seekPercent(this.value(), this.duration()));

  /** Gradient for the buffered band, or null → CSS falls back to the plain track. */
  readonly bufferedBackground = computed(() =>
    bufferedGradient(computeBufferedSegments(this.buffered(), this.duration())),
  );

  readonly disabled = computed(() => {
    const d = this.duration();
    return !Number.isFinite(d) || d <= 0;
  });

  onInput(event: Event): void {
    const v = Number((event.target as HTMLInputElement).value);
    this.scrub.set(v);
    this.preview.emit(v);
  }

  onChange(event: Event): void {
    const v = Number((event.target as HTMLInputElement).value);
    this.scrub.set(null);
    this.seek.emit(v);
  }
}

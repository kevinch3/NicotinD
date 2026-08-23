import { Component, computed, input, output } from '@angular/core';
import { envelopePath } from '../../../lib/waveform-geometry';
import { seekPercent } from '../../../lib/seek-utils';
import type { WaveformData } from '../../../../types/core';

/** viewBox size; CSS stretches it (`preserveAspectRatio="none"`). */
const VIEW_WIDTH = 600;
const VIEW_HEIGHT = 48;
/** Envelope columns — finer than any phone width needs, coarse enough to stay a short path. */
const COLUMNS = 300;

/**
 * app-now-playing-waveform — the precomputed min/max envelope drawn above the
 * seek bar in the Now Playing sheet (issue #643). Static SVG, no per-frame
 * work: progress is a CSS `clip-path` on the played overlay, so playback
 * costs nothing here.
 *
 * It is **decorative and tap-to-seek only**. The native `<input type="range">`
 * seek bar below it stays the accessible, keyboard and D-pad control — this
 * strip is `aria-hidden`, never a focus stop (a focusable strip would be one
 * more thing eating arrow keys on TV, issue #438), and renders nothing at all
 * until the artifact has loaded, so the layout never reserves space for a
 * waveform the server can't provide.
 */
@Component({
  selector: 'app-now-playing-waveform',
  templateUrl: './now-playing-waveform.component.html',
})
export class NowPlayingWaveformComponent {
  readonly waveform = input<WaveformData | null>(null);
  /** Current position, seconds. */
  readonly progress = input(0);
  /** Track duration, seconds; 0 disables seeking. */
  readonly duration = input(0);
  /** Committed seek target, absolute seconds. */
  readonly seek = output<number>();

  readonly viewWidth = VIEW_WIDTH;
  readonly viewHeight = VIEW_HEIGHT;

  readonly path = computed(() =>
    envelopePath(this.waveform()?.peaks ?? [], VIEW_WIDTH, VIEW_HEIGHT, COLUMNS),
  );

  /** 0..100, the played fraction the overlay is clipped to. */
  readonly percent = computed(() => seekPercent(this.progress(), this.duration()));

  /** Seek to a fraction (0..1) of the track; clamped, no-op without a duration. */
  seekAt(fraction: number): void {
    const d = this.duration();
    if (!Number.isFinite(d) || d <= 0) return;
    const f = Math.min(1, Math.max(0, fraction));
    this.seek.emit(f * d);
  }

  onPointerDown(event: PointerEvent): void {
    const rect = (event.currentTarget as Element).getBoundingClientRect();
    if (rect.width <= 0) return;
    this.seekAt((event.clientX - rect.left) / rect.width);
  }
}

import { Component, computed, input, output } from '@angular/core';
import { envelopePath } from '../../../lib/waveform-geometry';
import { seekPercent } from '../../../lib/seek-utils';
import type { WaveformData } from '../../../../types/core';

/** viewBox size; CSS stretches it (`preserveAspectRatio="none"`). */
const VIEW_WIDTH = 600;
const VIEW_HEIGHT = 48;
/** Envelope columns — finer than any phone width needs, coarse enough to stay a short path. */
const COLUMNS = 300;
/** Flat resting bar, in viewBox units (~1.7 px once the box is squashed to `h-10`). */
const BASELINE_HEIGHT = 2;

/**
 * app-now-playing-waveform — the precomputed min/max envelope drawn above the
 * seek bar in the Now Playing sheet (issue #643). Static SVG, no per-frame
 * work: progress is a CSS `clip-path` on the played overlay, so playback
 * costs nothing here.
 *
 * It is **decorative and tap-to-seek only**. The native `<input type="range">`
 * seek bar below it stays the accessible, keyboard and D-pad control — this
 * strip is `aria-hidden` and never a focus stop (a focusable strip would be one
 * more thing eating arrow keys on TV, issue #438).
 *
 * **The box is reserved from the first paint** (issue #657). The artifact is
 * decoded on demand server-side, so the first play of a track waits 1–3 s; the
 * strip used to render nothing until then and the transport below it dropped
 * 40 px on arrival, on every cold track *and* on every skip. Its height never
 * depended on the data, so both states now occupy the same box: a flat baseline
 * bar at rest, the envelope once it lands, cross-faded by `data-state` in
 * `styles.css`. Both layers stay mounted — a layer inserted in its final state
 * has no previous value to transition from.
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
  readonly baselineHeight = BASELINE_HEIGHT;
  readonly baselineY = (VIEW_HEIGHT - BASELINE_HEIGHT) / 2;

  readonly path = computed(() =>
    envelopePath(this.waveform()?.peaks ?? [], VIEW_WIDTH, VIEW_HEIGHT, COLUMNS),
  );

  /** Which of the two mounted layers the CSS shows. */
  readonly hasEnvelope = computed(() => this.path().length > 0);

  /** 0..100, the played fraction the overlay is clipped to. */
  readonly percent = computed(() => seekPercent(this.progress(), this.duration()));

  /** Played-overlay clip, shared by both layers so progress reads the same in either. */
  readonly clip = computed(() => `inset(0 ${100 - this.percent()}% 0 0)`);

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

import { Component, ElementRef, effect, input, untracked, viewChild } from '@angular/core';
import { BAND_COUNT, bandLevelsAt } from '../../../lib/waveform-geometry';
import { vfxShapes } from '../../../lib/vfx-scene';
import { DEFAULT_PALETTE, type CoverPalette } from '../../../lib/cover-colors';
import type { WaveformData } from '../../../../types/core';

/**
 * app-now-playing-vfx — the karaoke fullscreen's reactive backdrop (issue
 * #643): six glowing orbs driven by the precomputed band timeline sampled at
 * the playhead. Precomputed, not a live analyser, on purpose — routing the
 * `<audio>` element through Web Audio silenced playback on Android
 * (player.component.ts), and the A/B gapless pair would starve an analyser
 * anyway. Because it reads a fetched artifact, every device renders the same
 * frame for the same moment, and it works offline.
 *
 * Lifecycle: one `requestAnimationFrame` loop per play session inside an
 * `effect` with `cancelAnimationFrame` on cleanup (the same shape as the
 * remote-position interpolation in player.component.ts). While paused a single
 * frame is painted for the current position. The playhead between
 * `timeupdate`s is extrapolated on the wall clock, re-anchored on every update.
 */
@Component({
  selector: 'app-now-playing-vfx',
  host: { class: 'absolute inset-0 pointer-events-none' },
  template: `<canvas
    #canvas
    data-testid="karaoke-vfx"
    aria-hidden="true"
    class="block w-full h-full"
  ></canvas>`,
})
export class NowPlayingVfxComponent {
  readonly waveform = input<WaveformData | null>(null);
  /** Playhead, seconds. */
  readonly currentTime = input(0);
  readonly playing = input(false);
  readonly colors = input<CoverPalette>(DEFAULT_PALETTE);

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');

  constructor() {
    effect((onCleanup) => {
      const base = this.currentTime();
      if (!this.playing() || typeof requestAnimationFrame !== 'function') {
        this.renderFrame(base);
        return;
      }
      const started = performance.now();
      let raf = 0;
      const loop = (now: number): void => {
        this.renderFrame(base + (now - started) / 1000);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      onCleanup(() => cancelAnimationFrame(raf));
    });
  }

  /** Band levels under the playhead; silence when no artifact is loaded. */
  levelsAt(timeSec: number): number[] {
    const w = untracked(() => this.waveform());
    if (!w) return new Array<number>(BAND_COUNT).fill(0);
    return bandLevelsAt(w.bands, w.frameRate, timeSec);
  }

  /** Paint one frame. A no-op where there is no 2D context (jsdom, headless). */
  renderFrame(timeSec: number): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const palette = untracked(() => this.colors());
    const bandColor = [
      palette.glow,
      palette.glow,
      palette.secondary,
      palette.secondary,
      palette.primary,
      palette.primary,
    ];
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    for (const s of vfxShapes(this.levelsAt(timeSec), timeSec, w, h)) {
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.radius);
      g.addColorStop(0, bandColor[s.band] ?? palette.glow);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = s.alpha;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

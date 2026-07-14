import { Injectable } from '@angular/core';

/**
 * Client-side vocal removal via the Web Audio API.
 *
 * Each `<audio>` element gets a `MediaElementAudioSourceNode` (created once)
 * that routes through either the vocal-removal graph or a bypass straight to
 * the destination. Toggling is a `connect()` / `disconnect()` swap on the
 * filter node — the `<audio>` element's `src` and `currentTime` are never
 * touched, so playback continues seamlessly across the toggle.
 *
 * The filter is ffmpeg's `pan=stereo|c0=c0-c1|c1=c1-c0` equivalent: the
 * stereo channels are subtracted, cancelling any content panned to center
 * (vocals and bass). See `docs/vocal-mute.md` for why this is the right
 * approach on the web.
 */
@Injectable({ providedIn: 'root' })
export class VocalFilterService {
  private ctx: AudioContext | null = null;
  private sourceA: MediaElementAudioSourceNode | null = null;
  private sourceB: MediaElementAudioSourceNode | null = null;
  // Per-element filter node (when non-null, audio routes through it).
  private filterA: ChannelMergerNode | null = null;
  private filterB: ChannelMergerNode | null = null;
  private enabled = false;

  /**
   * Wire an audio element through the vocal-removal graph. Call this once per
   * `<audio>` element after it's been added to the DOM. Idempotent: calling
   * twice on the same element is a no-op.
   */
  attach(el: HTMLAudioElement): void {
    if (typeof window === 'undefined') return; // jsdom / SSR
    const AudioCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    if (!this.ctx) this.ctx = new AudioCtor();

    const source = this.ctx.createMediaElementSource(el);
    if (el.dataset['vocalFilterAttached'] === '1') return;
    el.dataset['vocalFilterAttached'] = '1';

    if (el.dataset['vocalSlot'] === 'A') {
      this.sourceA = source;
    } else {
      this.sourceB = source;
    }
    // Default: bypass (connect straight to destination).
    source.connect(this.ctx.destination);
  }

  /**
   * Toggle the vocal-removal filter on/off. Applies to both wired elements.
   * Tearing down and rebuilding the filter graph on every toggle would click;
   * instead, we keep the filter node alive and just re-route the connections.
   */
  setEnabled(enabled: boolean): void {
    if (!this.ctx || this.enabled === enabled) return;
    this.enabled = enabled;
    for (const source of [this.sourceA, this.sourceB]) {
      if (!source) continue;
      try {
        source.disconnect();
      } catch {
        // Already disconnected.
      }
      if (enabled) {
        if (!this.getOrCreateFilter(source)) return;
      } else {
        source.connect(this.ctx.destination);
      }
    }
  }

  private getOrCreateFilter(source: MediaElementAudioSourceNode): ChannelMergerNode | null {
    if (!this.ctx) return null;
    // Center-cancellation via channel subtraction. We build a minimal graph:
    //   source -> split into 2 channels
    //   ch0 -> GainNode(-1) -> merger input 0
    //   ch1 ->            -> merger input 1
    // The merger is the entry point connected to `source.context.destination`.
    const filter = this.ctx.createChannelMerger(2);
    const splitter = this.ctx.createChannelSplitter(2);
    const negate = this.ctx.createGain();
    negate.gain.value = -1;

    source.connect(splitter);
    splitter.connect(negate, 0);
    splitter.connect(filter, 1);
    negate.connect(filter, 0);
    filter.connect(this.ctx.destination);
    return filter;
  }

  /**
   * Tear down the graph (e.g., on component destroy). Safe to call multiple
   * times.
   */
  destroy(): void {
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
    this.sourceA = null;
    this.sourceB = null;
    this.filterA = null;
    this.filterB = null;
    this.enabled = false;
  }
}

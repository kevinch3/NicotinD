import { TestBed } from '@angular/core/testing';
import { NowPlayingVfxComponent } from './now-playing-vfx.component';
import { setInputValue } from '../../../../testing/signal-input';
import type { WaveformData } from '../../../../types/core';

const WAVE: WaveformData = {
  version: 1,
  duration: 1,
  peaks: [-0.5, 0.5],
  frameRate: 4,
  bands: [
    [0, 0, 0, 0, 0, 0],
    [1, 0.5, 0, 0, 0, 0],
    [0, 1, 0, 0, 0, 0],
    [0, 0, 1, 0, 0, 0],
  ],
};

function setup(opts: { waveform?: WaveformData | null; currentTime?: number } = {}) {
  TestBed.configureTestingModule({ imports: [NowPlayingVfxComponent] });
  const fixture = TestBed.createComponent(NowPlayingVfxComponent);
  const component = fixture.componentInstance;
  if (opts.waveform !== undefined) setInputValue(component.waveform, opts.waveform);
  if (opts.currentTime !== undefined) setInputValue(component.currentTime, opts.currentTime);
  fixture.detectChanges();
  return { fixture, component };
}

describe('NowPlayingVfxComponent', () => {
  it('mounts a non-interactive canvas behind the overlay content', () => {
    const { fixture } = setup({ waveform: WAVE });
    const canvas = fixture.nativeElement.querySelector('canvas[data-testid="karaoke-vfx"]');
    expect(canvas).not.toBeNull();
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
  });

  it('reads band levels under the playhead from the timeline', () => {
    const { component } = setup({ waveform: WAVE, currentTime: 0.25 });
    expect(component.levelsAt(0.25)).toEqual([1, 0.5, 0, 0, 0, 0]);
    expect(component.levelsAt(99)).toEqual([0, 0, 1, 0, 0, 0]);
  });

  it('is silent (all zeros) without a waveform, never throwing', () => {
    const { component } = setup({ waveform: null });
    expect(component.levelsAt(3)).toEqual([0, 0, 0, 0, 0, 0]);
    // jsdom has no 2D context; a frame must be a no-op, not an exception.
    expect(() => component.renderFrame(3)).not.toThrow();
  });
});

import { TestBed } from '@angular/core/testing';
import { NowPlayingWaveformComponent } from './now-playing-waveform.component';
import { setInputValue } from '../../../../testing/signal-input';
import type { WaveformData } from '../../../../types/core';

const WAVE: WaveformData = {
  version: 1,
  duration: 200,
  peaks: [-0.5, 0.5, -0.2, 0.9, -1, 0.1, -0.3, 0.3],
  frameRate: 4,
  bands: [[0, 0, 0, 0, 0, 0]],
};

function setup(
  opts: { waveform?: WaveformData | null; progress?: number; duration?: number } = {},
) {
  TestBed.configureTestingModule({ imports: [NowPlayingWaveformComponent] });
  const fixture = TestBed.createComponent(NowPlayingWaveformComponent);
  const component = fixture.componentInstance;
  // Inputs must land before the first detectChanges (see testing/signal-input.ts).
  if (opts.waveform !== undefined) setInputValue(component.waveform, opts.waveform);
  if (opts.progress !== undefined) setInputValue(component.progress, opts.progress);
  if (opts.duration !== undefined) setInputValue(component.duration, opts.duration);
  fixture.detectChanges();
  return { fixture, component };
}

describe('NowPlayingWaveformComponent', () => {
  it('renders the envelope as an SVG path once a waveform is available', () => {
    const { fixture } = setup({ waveform: WAVE, duration: 200 });
    const svg = fixture.nativeElement.querySelector('svg[data-testid="now-playing-waveform"]');
    expect(svg).not.toBeNull();
    const paths = svg.querySelectorAll('path');
    // Two copies of the same envelope: the unplayed base and the played overlay,
    // which is clipped to the progress fraction.
    expect(paths.length).toBe(2);
    expect(paths[0].getAttribute('d')).toMatch(/^M.*Z$/);
    expect(paths[1].getAttribute('d')).toBe(paths[0].getAttribute('d'));
  });

  it('renders nothing without a waveform — the native seek bar stays the control', () => {
    const { fixture } = setup({ waveform: null });
    expect(fixture.nativeElement.querySelector('svg')).toBeNull();
  });

  it('clips the played overlay to the progress fraction', () => {
    const { component } = setup({ waveform: WAVE, progress: 50, duration: 200 });
    expect(component.percent()).toBe(25);
  });

  it('emits an absolute seek for a tapped fraction of the strip', () => {
    const { component } = setup({ waveform: WAVE, duration: 200 });
    const seeks: number[] = [];
    component.seek.subscribe((v) => seeks.push(v));
    component.seekAt(0.25);
    component.seekAt(1.7); // clamped
    component.seekAt(-1); // clamped
    expect(seeks).toEqual([50, 200, 0]);
  });

  it('is decorative for assistive tech and never a focus stop (TV D-pad safety)', () => {
    const { fixture } = setup({ waveform: WAVE, duration: 200 });
    const svg = fixture.nativeElement.querySelector('svg');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('tabindex')).toBeNull();
  });
});

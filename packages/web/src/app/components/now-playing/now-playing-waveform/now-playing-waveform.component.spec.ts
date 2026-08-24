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
  // Reset first so one test can render two independent fixtures — comparing the
  // two states against each other is the only way to assert the box is stable
  // (the addon-status-panel spec's precedent).
  TestBed.resetTestingModule();
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

  it('reserves the strip\u2019s box with a flat baseline before the waveform arrives', () => {
    const { fixture } = setup({ waveform: null, duration: 200 });
    const svg = fixture.nativeElement.querySelector('svg[data-testid="now-playing-waveform"]');
    // The box is the whole point: it exists, at full height, before any data.
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('data-state')).toBe('baseline');
    expect(svg.querySelectorAll('rect').length).toBe(2);
    // Nothing is drawn as an envelope yet — the `d` attribute is absent, not empty.
    expect(svg.querySelectorAll('path[d]').length).toBe(0);
  });

  it('occupies the identical box in both states, so the arrival never shifts the layout', () => {
    const flat = setup({ waveform: null }).fixture.nativeElement.querySelector('svg');
    const drawn = setup({ waveform: WAVE, duration: 200 }).fixture.nativeElement.querySelector(
      'svg',
    );
    expect(flat.getAttribute('class')).toBe(drawn.getAttribute('class'));
    expect(flat.getAttribute('viewBox')).toBe(drawn.getAttribute('viewBox'));
  });

  it('switches state once the waveform arrives, so the CSS can cross-fade the two layers', () => {
    const { fixture } = setup({ waveform: WAVE, duration: 200 });
    const svg = fixture.nativeElement.querySelector('svg');
    expect(svg.getAttribute('data-state')).toBe('envelope');
    // Both layers stay mounted — a layer inserted in its final state cannot transition.
    expect(svg.querySelectorAll('rect').length).toBe(2);
  });

  it('shows the played fraction on the flat baseline too', () => {
    const { fixture } = setup({ waveform: null, progress: 50, duration: 200 });
    const overlay = fixture.nativeElement.querySelectorAll('rect')[1];
    expect(overlay.getAttribute('style')).toContain('inset(0 75% 0 0)');
  });

  it('seeks from a tap on the flat baseline, before any waveform has loaded', () => {
    const { fixture, component } = setup({ waveform: null, duration: 200 });
    const svg = fixture.nativeElement.querySelector('svg');
    // jsdom lays nothing out, so the strip has to be given a width to divide by.
    svg.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 40 }) as DOMRect;
    const seeks: number[] = [];
    component.seek.subscribe((v) => seeks.push(v));
    svg.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 50, bubbles: true }) as unknown as PointerEvent,
    );
    expect(seeks).toEqual([50]);
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

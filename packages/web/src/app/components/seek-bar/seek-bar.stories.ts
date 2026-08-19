import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { Component } from '@angular/core';
import { expect, waitFor } from 'storybook/test';
import { SeekBarComponent } from './seek-bar.component';

const meta: Meta<SeekBarComponent> = {
  title: 'Components/SeekBar',
  component: SeekBarComponent,
  tags: ['autodocs'],
  args: { position: 0, duration: 214, ariaLabel: 'Seek' },
};

export default meta;
type Story = StoryObj<SeekBarComponent>;

export const Start: Story = {};

export const MidTrack: Story = { args: { position: 96 } };

export const NearEnd: Story = { args: { position: 208 } };

/**
 * The buffered band is fed from `PlayerService.buffering`. It matters on HDD-backed
 * libraries, where the gap between "playing" and "fetched" is visible to the user.
 */
export const WithBufferedRanges: Story = {
  args: {
    position: 96,
    buffered: [
      { start: 0, end: 132 },
      { start: 160, end: 178 },
    ],
  },
};

/** A stream whose duration the browser has not resolved yet. */
export const UnknownDuration: Story = { args: { position: 0, duration: 0 } };

/**
 * Host wrapper that records emissions into the DOM.
 *
 * `preview` and `seek` are Angular `output()`s, so the only way a play function
 * can observe them is through something rendered — a spy passed via args would
 * depend on how the Angular renderer binds outputs, which is framework detail
 * this test should not be pinned to.
 */
@Component({
  selector: 'app-seek-bar-probe',
  standalone: true,
  imports: [SeekBarComponent],
  template: `
    <app-seek-bar
      [position]="96"
      [duration]="214"
      ariaLabel="Seek"
      (preview)="previews.push($any($event))"
      (seek)="seeks.push($any($event))"
    />
    <p data-testid="preview-count">{{ previews.length }}</p>
    <p data-testid="seek-count">{{ seeks.length }}</p>
    <p data-testid="last-seek">{{ seeks.at(-1) ?? '' }}</p>
  `,
})
class SeekBarProbeComponent {
  readonly previews: number[] = [];
  readonly seeks: number[] = [];
}

/**
 * Scrubbing emits `preview` continuously and `seek` exactly once, on commit
 * (issue #475).
 *
 * That split is the whole contract: `preview` drives the live time readout while
 * the thumb moves, and committing once on release is what stops a drag firing a
 * seek per pixel — which on a range-request stream would be a burst of aborted
 * fetches. Driven through the native `input`/`change` events the component
 * actually binds, so it tests the wiring rather than the class's methods (which
 * `seek-bar.component.spec.ts` already covers directly).
 */
export const ScrubEmitsPreviewThenOneSeek: StoryObj = {
  render: () => ({ template: '<app-seek-bar-probe />' }),
  decorators: [moduleMetadata({ imports: [SeekBarProbeComponent] })],
  play: async ({ canvasElement }) => {
    const range = canvasElement.querySelector<HTMLInputElement>('input[data-seek]');
    if (!range) throw new Error('seek input not found');
    const previewCount = () =>
      Number(canvasElement.querySelector('[data-testid="preview-count"]')!.textContent);
    const seekCount = () =>
      Number(canvasElement.querySelector('[data-testid="seek-count"]')!.textContent);

    expect(previewCount()).toBe(0);
    expect(seekCount()).toBe(0);

    // Drag: several input events, no commit yet.
    for (const v of [100, 120, 140]) {
      range.value = String(v);
      range.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await waitFor(() => expect(previewCount()).toBe(3));
    expect(seekCount()).toBe(0);

    // Release: exactly one commit, at the final position.
    range.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => expect(seekCount()).toBe(1));
    expect(canvasElement.querySelector('[data-testid="last-seek"]')!.textContent).toContain('140');
    // Still one commit — a release must not re-fire.
    expect(seekCount()).toBe(1);
  },
};

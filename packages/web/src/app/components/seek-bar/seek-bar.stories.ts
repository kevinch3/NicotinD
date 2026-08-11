import type { Meta, StoryObj } from '@storybook/angular';
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

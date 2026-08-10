import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { DeviceSwitcherComponent } from './device-switcher.component';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<DeviceSwitcherComponent> = {
  title: 'Components/DeviceSwitcher',
  component: DeviceSwitcherComponent,
  tags: ['autodocs'],
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: { placement: 'up' },
};

export default meta;
type Story = StoryObj<DeviceSwitcherComponent>;

/**
 * Every browser tab is a playback device, registered over `GET /api/ws/playback`.
 * Storybook has no WebSocket, so the list shows only this tab — the point of the story is
 * the control and its placement, not the device roster.
 */
export const PlacementUp: Story = {};

/** `down` is for triggers near the top of the viewport, e.g. the desktop header. */
export const PlacementDown: Story = { args: { placement: 'down' } };

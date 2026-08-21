import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { DeviceSwitcherComponent } from './device-switcher.component';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<DeviceSwitcherComponent> = {
  title: 'Components/DeviceSwitcher',
  component: DeviceSwitcherComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Picks which device plays. Every browser tab registers as a device over `GET /api/ws/playback`. Casting to hardware (Chromecast, DLNA) is designed but not built — see docs/cast-integration.md — so every device listed here is a browser tab.',
      },
    },
  },
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

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
  decorators: [
    applicationConfig({
      // Storybook has no WebSocket, so the roster would be empty — and the
      // control only renders when there is somewhere else to send the audio
      // (docs/remote-playback.md). These stand in for the other tabs a real
      // session would have synced; their ids differ from this tab's, which is
      // all "another device" means here.
      providers: storyProviders({
        remoteSession: {
          activeDeviceId: null,
          devices: [
            { id: 'living-room', name: 'Chrome on Living Room TV', type: 'web', lastSeen: 0 },
            { id: 'phone', name: 'Safari on iPhone', type: 'web', lastSeen: 0 },
          ],
        },
      }),
    }),
  ],
  args: { placement: 'up' },
};

export default meta;
type Story = StoryObj<DeviceSwitcherComponent>;

/**
 * Every browser tab is a playback device, registered over `GET /api/ws/playback`.
 * The roster here is seeded by the decorator, because the control hides itself
 * when this tab is the only device there is.
 */
export const PlacementUp: Story = {};

/** `down` is for triggers near the top of the viewport, e.g. the desktop header. */
export const PlacementDown: Story = { args: { placement: 'down' } };

/**
 * Nothing else is playing anywhere, so there is nothing to pick and the control
 * renders nothing at all — no dead cast button beside Next on a one-device
 * setup (docs/remote-playback.md "The picker hides when there is nothing to
 * pick").
 */
export const NoOtherDevices: Story = {
  decorators: [
    applicationConfig({
      providers: storyProviders({ remoteSession: { activeDeviceId: null, devices: [] } }),
    }),
  ],
};

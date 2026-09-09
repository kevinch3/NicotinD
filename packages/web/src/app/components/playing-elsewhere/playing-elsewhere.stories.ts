import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { PlayingElsewhereComponent } from './playing-elsewhere.component';
import { storyProviders } from '../../../stories/support/story-providers';

const tv = { id: 'tv', name: 'Living Room TV', type: 'web', lastSeen: 0 };

const meta: Meta<PlayingElsewhereComponent> = {
  title: 'Components/PlayingElsewhere',
  component: PlayingElsewhereComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The accent strip a controller shows above its player while the audio plays on another of the user\'s devices. Tapping it opens the device switcher. It is the Spotify "Listening on…" idea in NicotinD\'s own accent, and the only persistent sign of a session on a controller — see docs/remote-playback.md.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<PlayingElsewhereComponent>;

/** The session names a device this one can drive. */
export const PlayingOnAnotherDevice: Story = {
  decorators: [
    applicationConfig({
      providers: storyProviders({ remoteSession: { activeDeviceId: 'tv', devices: [tv] } }),
    }),
  ],
};

/** The output opted out of remote control: the strip says the transport here is inert. */
export const NotControllable: Story = {
  decorators: [
    applicationConfig({
      providers: storyProviders({
        remoteSession: { activeDeviceId: 'tv', devices: [{ ...tv, available: false }] },
      }),
    }),
  ],
};

/** The output's socket blipped; the session survives the grace. */
export const Reconnecting: Story = {
  decorators: [
    applicationConfig({
      providers: storyProviders({
        remoteSession: { activeDeviceId: 'tv', devices: [{ ...tv, pending: true }] },
      }),
    }),
  ],
};

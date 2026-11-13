import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { GetTrackRowComponent } from './get-track-row.component';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<GetTrackRowComponent> = {
  title: 'Components/GetTrackRow',
  component: GetTrackRowComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'One track on the Get page, whichever source found it. Two lines: what it is, then where it comes from and what decides between copies. On the right the same slots as the album card: the action, then Cancel while its job runs.',
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: {
    title: "L'estasi dell'oro",
    subtitle: 'Ennio Morricone',
    facts: 'FLAC · 28 MB · 5:12',
    source: 'network',
    sourceLabel: 'Peer network',
    state: 'idle',
    copies: 14,
  },
};

export default meta;
type Story = StoryObj<GetTrackRowComponent>;

export const Idle: Story = {};

/** Its job is running: the percent, and Cancel beside it. */
export const Downloading: Story = { args: { state: 'working', percent: 42, cancelJobId: 'j1' } };

/** On disk; filing it into the library is still to come, so it does not say "In library". */
export const Downloaded: Story = { args: { state: 'done' } };

/** A link job handed off. */
export const Queued: Story = {
  args: { source: 'archive', sourceLabel: 'Internet Archive', state: 'queued', copies: 0 },
};

/** A Spotify match with no resolver enabled opens Spotify instead. */
export const OpensExternally: Story = {
  args: { source: 'spotify', sourceLabel: 'Spotify', opensExternally: true, copies: 0 },
};

/** A lossless pick stored as Opus. */
export const Transcoded: Story = { args: { transcodeKbps: 192 } };

import {
  applicationConfig,
  componentWrapperDecorator,
  type Meta,
  type StoryObj,
} from '@storybook/angular';
import { GetAlbumCardComponent } from './get-album-card.component';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<GetAlbumCardComponent> = {
  title: 'Components/GetAlbumCard',
  component: GetAlbumCardComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'One album on the Get page, whichever lane named it: a catalog release or an album only a source holds. Four text lines, of which only the last changes: what a source offers, what the Get is doing, or that the library already has it. Get is always an explicit button, and the cover opens the copies.',
      },
    },
  },
  decorators: [
    applicationConfig({ providers: storyProviders() }),
    componentWrapperDecorator((story) => `<div style="width: 13rem">${story}</div>`),
  ],
  args: {
    title: 'Meddle',
    artist: 'Pink Floyd',
    meta: '1971 · Album · 6 tracks',
    status: { phase: 'idle' },
    availability: '12 peers · FLAC · complete',
    hasCopies: true,
    showWatch: true,
  },
};

export default meta;
type Story = StoryObj<GetAlbumCardComponent>;

/** A source holds it: Get on the left, Copies beside it. */
export const Idle: Story = {};

/** The click is in; the server is looking for a source. */
export const Finding: Story = { args: { status: { phase: 'searching', jobId: 'j1' } } };

/** Cancel sits where Get was; the bar on the cover is the share delivered. */
export const Downloading: Story = {
  args: { status: { phase: 'job', stage: 'downloading', jobId: 'j1', delivered: 4, expected: 6 } },
};

/** Already owned: said before the click, with the way in. */
export const InLibrary: Story = { args: { library: { albumId: 'a1', partial: false } } };

/** Some tracks on disk: the same button completes it. */
export const PartlyInLibrary: Story = { args: { library: { albumId: 'a1', partial: true } } };

/** A finished search saw no copy. It keeps its place and its Get. */
export const NoCopySeen: Story = { args: { availability: null, hasCopies: false } };

/** An album only a source holds: no cover, no catalog facts, same card. */
export const ProviderOnly: Story = {
  args: { origin: 'provider', meta: '', showWatch: false, watched: false },
};

/** Watched: the star stays lit. */
export const Watched: Story = { args: { watched: true } };

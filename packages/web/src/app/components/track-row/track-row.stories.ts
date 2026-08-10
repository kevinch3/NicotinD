import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { TrackRowComponent } from './track-row.component';
import { storyProviders } from '../../../stories/support/story-providers';
import { demoArtistCredits, demoTrack } from '../../../stories/support/fixtures';

const meta: Meta<TrackRowComponent> = {
  title: 'Components/TrackRow',
  component: TrackRowComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The one row component behind every song listing — album, playlist, queue, search, artist Songs, the library Songs tab and the offline list. Its `⋯` menu is built by `SongMenuService.build(song, ctx)`, so common actions are guaranteed everywhere and contextual ones arrive through `SongContext`. `currentTrack` is set synchronously on click, so the row acknowledges a tap before any (HDD-slow) bytes arrive.',
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: {
    track: demoTrack,
    artists: demoArtistCredits,
    duration: 214,
    showLike: true,
    showCover: true,
  },
};

export default meta;
type Story = StoryObj<TrackRowComponent>;

export const Default: Story = {};

/** Playing rows swap the index for an equaliser indicator. */
export const Playing: Story = {
  decorators: [
    applicationConfig({
      providers: storyProviders({ currentTrack: demoTrack, isPlaying: true }),
    }),
  ],
};

/**
 * The buffering state is the instant click acknowledgement — `currentTrack` is set
 * synchronously on click so the row responds before any (HDD-slow) bytes arrive.
 */
export const Buffering: Story = {
  decorators: [
    applicationConfig({
      providers: storyProviders({ currentTrack: demoTrack, isPlaying: true, buffering: true }),
    }),
  ],
};

/** Numbered rows in a single-album context, where every track shares one cover. */
export const InAlbumContext: Story = {
  args: { indexLabel: 3, showCover: false },
};

export const WithSubtitle: Story = {
  args: { subtitle: 'Static Bloom · 2025' },
};

export const Selectable: Story = {
  args: { selectable: true, selected: true },
};

export const Disabled: Story = {
  args: { disabled: true },
};

/** Offline rows drop the like button and the server-backed menu entries. */
export const Offline: Story = {
  args: { offline: true, showLike: false },
};

export const WithActions: Story = {
  args: {
    showRemove: true,
    actions: [
      { label: 'Play next', icon: 'play', action: () => undefined },
      { label: 'Add to queue', icon: 'plus', action: () => undefined },
      { label: 'Remove', icon: 'trash', action: () => undefined, destructive: true },
    ],
  },
};

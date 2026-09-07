import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { AlbumTileComponent } from './album-tile.component';
import { storyProviders } from '../../../stories/support/story-providers';
import type { AlbumTile } from '../../lib/artist-album-tiles';

const tile = (over: Partial<AlbumTile> & Pick<AlbumTile, 'status'>): AlbumTile => ({
  key: 'k',
  title: 'Meddle',
  year: 1971,
  secondary: false,
  ...over,
});

const meta: Meta<AlbumTileComponent> = {
  title: 'Components/AlbumTile',
  component: AlbumTileComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          "One album in an artist's grid, in one of three states. The artist page used to render the library and the MusicBrainz discography as two separate grids of the same albums; this tile is what lets them be one. An album you own looks exactly as it always did, an album you own part of carries its track count and a Complete album button, and an album you do not own is dimmed with a Get album button. A complete album gets nothing extra — the grid stays quiet where there is nothing to do.",
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: { artistName: 'Pink Floyd', canAcquire: true, busy: false },
};

export default meta;
type Story = StoryObj<AlbumTileComponent>;

/** The common case: the whole album is on disk, so the tile offers no action at all. */
export const Owned: Story = {
  args: { tile: tile({ status: 'owned', localAlbumId: 'a1' }) },
};

/**
 * Four of seven tracks landed. Still yours and still playable, so it navigates and
 * is not dimmed — the count and the button carry the gap.
 */
export const Partial: Story = {
  args: {
    tile: tile({
      status: 'partial',
      title: 'A Saucerful of Secrets',
      year: 1968,
      localAlbumId: 'a2',
      localTrackCount: 4,
      totalTracks: 7,
    }),
  },
};

/** Not in the library. Nowhere to navigate to, so the tile is inert and dimmed. */
export const Missing: Story = {
  args: {
    tile: tile({ status: 'missing', title: 'Atom Heart Mother', year: 1970, totalTracks: 5 }),
  },
};

/** A hunt is in flight — the button holds its place rather than disappearing. */
export const Hunting: Story = {
  args: {
    tile: tile({ status: 'missing', title: 'Atom Heart Mother', year: 1970 }),
    busy: true,
  },
};

/**
 * A listener cannot acquire, so both actions are hidden. Before this, the grid
 * offered them a button whose route answers 403.
 */
export const ListenerCannotAcquire: Story = {
  args: {
    tile: tile({ status: 'missing', title: 'Atom Heart Mother', year: 1970 }),
    canAcquire: false,
  },
};

/** An EP on the Singles tab: the subtitle picks up the kind between year and counts. */
export const EpWithKind: Story = {
  args: {
    tile: tile({ status: 'owned', title: 'Ummagumma', year: 1969, localAlbumId: 'a3', kind: 'EP' }),
  },
};

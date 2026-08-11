import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { AddToPlaylistComponent } from './add-to-playlist.component';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<AddToPlaylistComponent> = {
  title: 'Components/AddToPlaylist',
  component: AddToPlaylistComponent,
  tags: ['autodocs'],
  decorators: [applicationConfig({ providers: storyProviders() })],
};

export default meta;
type Story = StoryObj<AddToPlaylistComponent>;

/**
 * Playlist chooser reached from the song menu. Curated (`kind='curated'`) and Liked Songs
 * (`kind='liked'`) rows are read-only through the CRUD API, so only `kind='user'`
 * playlists are valid targets here.
 */
export const Default: Story = {};

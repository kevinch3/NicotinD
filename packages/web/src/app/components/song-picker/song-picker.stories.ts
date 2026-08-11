import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { SongPickerComponent } from './song-picker.component';
import { storyProviders } from '../../../stories/support/story-providers';
import { demoSongs } from '../../../stories/support/fixtures';

const meta: Meta<SongPickerComponent> = {
  title: 'Components/SongPicker',
  component: SongPickerComponent,
  tags: ['autodocs'],
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: { excludeIds: [] },
};

export default meta;
type Story = StoryObj<SongPickerComponent>;

/**
 * Debounced autocomplete over the library, used by the playlist detail page. Type to
 * search — the Storybook fixture transport answers `/api/search` with the demo album, so
 * any query returns the same seven tracks.
 */
export const Empty: Story = {};

/** Songs already in the playlist are excluded so you cannot add a duplicate. */
export const WithExclusions: Story = {
  args: { excludeIds: demoSongs.slice(0, 4).map((s) => s.id) },
};

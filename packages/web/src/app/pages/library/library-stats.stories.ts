import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular-vite';
import { LibraryStatsComponent } from './library-stats.component';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<LibraryStatsComponent> = {
  title: 'Pages/LibraryStats',
  component: LibraryStatsComponent,
  parameters: {
    docs: {
      description: {
        component:
          'The Library Stats tab. A top row whose song, artist or album is still in the library is a link with artwork (a song row plays it, an artist row offers Radio); a row whose target was deleted is plain text. The fixture carries one deleted row per list and one long artist name.',
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
};

export default meta;
type Story = StoryObj<LibraryStatsComponent>;

export const Default: Story = {};

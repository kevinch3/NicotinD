import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { RelatedArtistsComponent } from './related-artists.component';
import { storyProviders } from '../../../stories/support/story-providers';
import type { RelatedArtist } from '../../services/api/api-types';

const artist = (name: string, cosine: number): RelatedArtist => ({
  id: name.toLowerCase().replace(/\W+/g, '-'),
  name,
  coverArt: null,
  albumCount: 3,
  score: cosine,
  signals: { audio: { cosine, members: 20, coherence: 0.8 } },
});

const demo = [
  artist('Luis Alberto Spinetta', 0.93),
  artist('Queen', 0.923),
  artist('Serú Girán', 0.916),
  artist('David Bowie', 0.901),
  artist('Charly García', 0.894),
  artist('The Beatles', 0.885),
  artist('Pescado Rabioso', 0.885),
  artist('Gustavo Cerati', 0.868),
];

const meta: Meta<RelatedArtistsComponent> = {
  title: 'Components/RelatedArtists',
  component: RelatedArtistsComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The artist page footer: library artists that sound like this one, nearest first, from per-artist audio centroids. A row that scrolls sideways rather than a grid, because it is a way out of the page and not the page itself. It renders nothing when there is nothing to show.',
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: { artists: demo, token: 'demo' },
};

export default meta;
type Story = StoryObj<RelatedArtistsComponent>;

/** Pink Floyd's row as measured on a real library. */
export const Default: Story = {};

export const Few: Story = { args: { artists: demo.slice(0, 2) } };

/** Long names truncate under the cover instead of widening the tile. */
export const LongNames: Story = {
  args: {
    artists: [
      artist('Orquesta Típica Víctor y su Cantor de Siempre', 0.9),
      artist('Los Fabulosos Cadillacs', 0.89),
    ],
  },
};

/** Nothing renders — the page shows no empty shelf. */
export const Empty: Story = { args: { artists: [] } };

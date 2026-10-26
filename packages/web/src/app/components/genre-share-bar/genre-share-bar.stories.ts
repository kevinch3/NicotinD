import type { Meta, StoryObj } from '@storybook/angular';
import { GenreShareBarComponent } from './genre-share-bar.component';

const meta: Meta<GenreShareBarComponent> = {
  title: 'Components/GenreShareBar',
  component: GenreShareBarComponent,
  tags: ['autodocs'],
  args: {
    taggedCount: 50,
    slices: [
      { genre: 'Pop', count: 24, weight: 0.48 },
      { genre: 'Salsa', count: 9, weight: 0.18 },
      { genre: 'Latin Pop', count: 7, weight: 0.14 },
      { genre: 'Ballad', count: 4, weight: 0.08 },
      { genre: 'Tropical', count: 3, weight: 0.06 },
      { genre: 'Other', count: 3, weight: 0.06 },
    ],
  },
};

export default meta;
type Story = StoryObj<GenreShareBarComponent>;

/**
 * The artist page's About-block chart (#1572): each track counted once by its
 * primary genre, so segments sum to 100% — unlike `GenreDistributionStrip`.
 */
export const Default: Story = {};

export const SingleGenre: Story = {
  args: { taggedCount: 12, slices: [{ genre: 'Rock', count: 12, weight: 1 }] },
};

export const TwoGenres: Story = {
  args: {
    taggedCount: 20,
    slices: [
      { genre: 'Cumbia', count: 13, weight: 0.65 },
      { genre: 'Reggae', count: 7, weight: 0.35 },
    ],
  },
};

export const Empty: Story = { args: { slices: [], taggedCount: 0 } };

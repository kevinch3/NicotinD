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
      { genre: 'Other', count: 3, weight: 0.06, kind: 'other' },
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

/** Library Stats (#1670): one genre dominates, the rest is a real minority. */
export const DominantGenre: Story = {
  args: {
    caption: 'Of 212 plays, each counted once by its track’s main genre',
    slices: [
      { genre: 'Cumbia', count: 161, weight: 161 / 212, percent: 76 },
      { genre: 'Rock', count: 51, weight: 51 / 212, percent: 24 },
    ],
  },
};

/** Two equal genres both read 50% — never "100% and 100%". */
export const Tie: Story = {
  args: {
    caption: 'Of 10 plays, each counted once by its track’s main genre',
    slices: [
      { genre: 'Pop', count: 5, weight: 0.5, percent: 50 },
      { genre: 'Rap', count: 5, weight: 0.5, percent: 50 },
    ],
  },
};

/** The folded tail and the untagged bucket: neutral, last, still visible. */
export const LongTailWithUntagged: Story = {
  args: {
    caption: 'Of 100 plays, each counted once by its track’s main genre',
    slices: [
      { genre: 'Techno', count: 30, weight: 0.3, percent: 30 },
      { genre: 'House', count: 20, weight: 0.2, percent: 20 },
      { genre: 'Ambient', count: 10, weight: 0.1, percent: 10 },
      { genre: 'Other genres', count: 15, weight: 0.15, percent: 15, kind: 'other' },
      { genre: 'Untagged', count: 25, weight: 0.25, percent: 25, kind: 'untagged' },
    ],
  },
};

export const AllUntagged: Story = {
  args: {
    caption: 'Of 8 plays, each counted once by its track’s main genre',
    slices: [{ genre: 'Untagged', count: 8, weight: 1, percent: 100, kind: 'untagged' }],
  },
};

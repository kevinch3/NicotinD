import type { Meta, StoryObj } from '@storybook/angular';
import { GenreDistributionStripComponent } from './genre-distribution-strip.component';
import { demoGenreSlices } from '../../../stories/support/fixtures';

const meta: Meta<GenreDistributionStripComponent> = {
  title: 'Components/GenreDistributionStrip',
  component: GenreDistributionStripComponent,
  tags: ['autodocs'],
  args: { slices: demoGenreSlices, trackCount: 47, genreCount: 9 },
};

export default meta;
type Story = StoryObj<GenreDistributionStripComponent>;

/**
 * The listener-facing counterpart to `GenreRadar`. Plain CSS bar fills, not the SVG
 * radar: the radar is a curation review aid inside the genre-fix modal, this is a
 * read-only summary on artist and album pages.
 */
export const Default: Story = {};

export const AlbumScale: Story = {
  args: { slices: demoGenreSlices.slice(0, 3), trackCount: 7, genreCount: 3 },
};

export const SingleGenre: Story = {
  args: { slices: [{ genre: 'Dream Pop', count: 7, weight: 1 }], trackCount: 7, genreCount: 1 },
};

export const Empty: Story = { args: { slices: [], trackCount: 0, genreCount: 0 } };

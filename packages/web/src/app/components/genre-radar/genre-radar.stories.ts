import type { Meta, StoryObj } from '@storybook/angular';
import { GenreRadarComponent } from './genre-radar.component';
import { demoGenreSlices } from '../../../stories/support/fixtures';

const meta: Meta<GenreRadarComponent> = {
  title: 'Components/GenreRadar',
  component: GenreRadarComponent,
  tags: ['autodocs'],
  args: { slices: demoGenreSlices, trackCount: 47, genreCount: 9 },
};

export default meta;
type Story = StoryObj<GenreRadarComponent>;

/**
 * Weights are each genre's share of the artist's landed tracks, so they deliberately do
 * not sum to 1 — genre sets overlap, and normalising would under-report every
 * multi-genre track. It is position-blind, matching `genreSetCloseness`.
 *
 * A radar overstates differences because area grows with radius², which is why the paired
 * value table always ships beside the chart rather than as an option.
 */
export const Default: Story = {};

export const SingleGenre: Story = {
  args: { slices: [{ genre: 'Dream Pop', count: 47, weight: 1 }], trackCount: 47, genreCount: 1 },
};

export const TwoGenres: Story = {
  args: { slices: demoGenreSlices.slice(0, 2), trackCount: 47, genreCount: 2 },
};

/** Beyond eight axes the rest fold into a capped "Other" so the polygon stays readable. */
export const ManyGenres: Story = {
  args: {
    slices: [
      ...demoGenreSlices,
      { genre: 'Krautrock', count: 5, weight: 0.11 },
      { genre: 'Drone', count: 4, weight: 0.09 },
      { genre: 'Trip Hop', count: 3, weight: 0.06 },
      { genre: 'Downtempo', count: 2, weight: 0.04 },
      { genre: 'Folk', count: 1, weight: 0.02 },
    ],
    trackCount: 47,
    genreCount: 12,
  },
};

export const Empty: Story = { args: { slices: [], trackCount: 0, genreCount: 0 } };

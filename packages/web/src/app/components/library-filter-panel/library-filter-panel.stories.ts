import type { Meta, StoryObj } from '@storybook/angular';
import { LibraryFilterPanelComponent } from './library-filter-panel.component';

const GENRES = ['Ambient', 'Dream Pop', 'Post-Rock', 'Shoegaze', 'Slowcore', 'Trip Hop'];

const meta: Meta<LibraryFilterPanelComponent> = {
  title: 'Components/LibraryFilterPanel',
  component: LibraryFilterPanelComponent,
  tags: ['autodocs'],
  args: { filter: {}, genres: GENRES, testIdPrefix: 'library', extraCount: 0 },
};

export default meta;
type Story = StoryObj<LibraryFilterPanelComponent>;

/**
 * Stateless by design: the host owns the `LibraryFilter` (usually mirrored into URL query
 * params) and every control emits a fresh immutable object through `filterChange`.
 * Click the trigger to open the popover.
 */
export const NoFilter: Story = {};

export const WithActiveFilter: Story = {
  args: { filter: { bpmMin: 90, bpmMax: 130, genres: ['Dream Pop'], starred: true } },
};

export const MoodAndPerceptual: Story = {
  args: {
    filter: { moods: ['relaxed'], buckets: { energy: ['low'], danceability: ['high'] } },
  },
};

/** Page-specific extras project in through the content slot and report their own count. */
export const WithHostExtras: Story = {
  args: { filter: { yearMin: 2015 }, extraCount: 2 },
};

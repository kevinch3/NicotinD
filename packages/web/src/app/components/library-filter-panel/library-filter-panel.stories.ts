import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { LibraryFilterPanelComponent } from './library-filter-panel.component';
import { storyProviders } from '../../../stories/support/story-providers';

const GENRES = ['Ambient', 'Dream Pop', 'Post-Rock', 'Shoegaze', 'Slowcore', 'Trip Hop'];

const meta: Meta<LibraryFilterPanelComponent> = {
  title: 'Components/LibraryFilterPanel',
  component: LibraryFilterPanelComponent,
  tags: ['autodocs'],
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: { filter: {}, genres: GENRES, testIdPrefix: 'library', extraCount: 0, compact: false },
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

/**
 * The Library tabs' icon-only trigger: the accessible name is `aria-label`, and
 * the active count rides the corner so the button stays one square wide.
 */
export const Compact: Story = {
  args: { filter: { bpmMin: 90, starred: true }, compact: true },
};

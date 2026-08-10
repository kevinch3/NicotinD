import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { ArtistGenreModalComponent } from './artist-genre-modal.component';
import { storyProviders } from '../../../stories/support/story-providers';
import { DEMO_ARTIST_ID } from '../../../stories/support/fixtures';

const meta: Meta<ArtistGenreModalComponent> = {
  title: 'Components/ArtistGenreModal',
  component: ArtistGenreModalComponent,
  tags: ['autodocs'],
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: { artistId: DEMO_ARTIST_ID, artistName: 'Nocturnal Signal' },
};

export default meta;
type Story = StoryObj<ArtistGenreModalComponent>;

/**
 * The curator's genre-fix surface, writing `library_genre_overrides`. Two things here are
 * load-bearing:
 *
 * - **append vs replace is a real choice, not a default.** Replace is required when the
 *   tag genres are broad and wrong, because `genreSetCloseness` is a position-blind MAX —
 *   a retained broad genre masks the fix. Append is right when they are specific and
 *   correct; a blanket replace once flattened 34 songs onto one list.
 * - **The radar is a review aid, not the answer.** It overstates differences (area grows
 *   with radius²), so the paired value table always ships with it, and the projected
 *   spread renders live beside the current one — the append/replace choice was invisible
 *   until Save otherwise.
 */
export const Default: Story = {};

export const AsListener: Story = {
  decorators: [applicationConfig({ providers: storyProviders({ role: 'listener' }) })],
};

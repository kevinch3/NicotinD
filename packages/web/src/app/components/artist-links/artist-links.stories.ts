import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { ArtistLinksComponent } from './artist-links.component';
import { storyProviders } from '../../../stories/support/story-providers';
import { demoArtistCredits } from '../../../stories/support/fixtures';

const meta: Meta<ArtistLinksComponent> = {
  title: 'Components/ArtistLinks',
  component: ArtistLinksComponent,
  tags: ['autodocs'],
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: { artists: demoArtistCredits },
};

export default meta;
type Story = StoryObj<ArtistLinksComponent>;

/** Credits come from `library_song_artists`; featuring artists render after primaries. */
export const PrimaryAndFeaturing: Story = {};

export const SinglePrimary: Story = { args: { artists: [demoArtistCredits[0]] } };

export const ManyCredits: Story = {
  args: {
    artists: [
      { id: 'a1', name: 'Nocturnal Signal', role: 'primary' },
      { id: 'a2', name: 'Mira Oduya', role: 'featuring' },
      { id: 'a3', name: 'Halden Ross', role: 'featuring' },
      { id: 'a4', name: 'The Quiet Hours', role: 'featuring' },
    ],
  },
};

/**
 * With no structured credits the row falls back to the raw tag string — what every
 * pre-multi-artist row looks like until the identity task resolves it.
 */
export const FallbackToRawTag: Story = {
  args: { artists: undefined, fallbackArtist: 'Nocturnal Signal & Mira Oduya' },
};

export const FallbackWithLink: Story = {
  args: {
    artists: undefined,
    fallbackArtist: 'Nocturnal Signal',
    fallbackArtistId: 'artist-nocturnal-signal',
  },
};

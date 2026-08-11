import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { ArtistInfoComponent } from './artist-info.component';
import { storyProviders } from '../../../stories/support/story-providers';
import { DEMO_ARTIST_ID } from '../../../stories/support/fixtures';

const BIO =
  'Nocturnal Signal formed in 2018 around the nucleus of [a=Mira Oduya] and [a=Halden Ross], ' +
  'releasing their first tapes on [l=Jive] before signing to a larger independent. ' +
  "Their sound draws on [b]dream pop[/b] and [i]shoegaze[/i], with the band citing ''late-night radio'' " +
  'as a formative influence. See https://example.org/nocturnal-signal for the full discography.';

const meta: Meta<ArtistInfoComponent> = {
  title: 'Components/ArtistInfo',
  component: ArtistInfoComponent,
  tags: ['autodocs'],
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: { artistId: DEMO_ARTIST_ID, bio: BIO, urls: ['https://musicbrainz.org/artist/demo'] },
};

export default meta;
type Story = StoryObj<ArtistInfoComponent>;

/**
 * The bio arrives as Discogs BBCode and is cleaned by the pure `formatArtistBio` on every
 * render — this story deliberately feeds it the raw form. Both reference shapes matter:
 * named refs (`[a=Name]`, `[l=Jive]`) keep their embedded name, numeric id refs
 * (`[a123]`) are dropped. Handling only the named shape is what leaked literal garbage
 * into the UI the first time round.
 *
 * Bare trailing URLs move into a "Sources" disclosure, deduped against the API `urls`.
 */
export const WithBbcodeBio: Story = {};

export const ShortBio: Story = {
  args: { bio: 'A duo from Rosario working in dream pop and ambient.', urls: [] },
};

/**
 * No bio yet. The artist page fires a silent one-shot auto-fetch on first visit
 * (`POST /artists/:id/auto-fetch-info`), gated so it never re-queries a confirmed miss
 * and never overwrites a manual override.
 */
export const Empty: Story = { args: { bio: null, urls: [] } };

/** Editing is curator-gated; a listener sees the prose and no controls. */
export const AsListener: Story = {
  decorators: [applicationConfig({ providers: storyProviders({ role: 'listener' }) })],
};

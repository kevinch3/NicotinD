import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { ArtistIdentityModalComponent } from './artist-identity-modal.component';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<ArtistIdentityModalComponent> = {
  title: 'Components/ArtistIdentityModal',
  component: ArtistIdentityModalComponent,
  tags: ['autodocs'],
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: { rawName: 'Nocturnal Signal & Mira Oduya' },
};

export default meta;
type Story = StoryObj<ArtistIdentityModalComponent>;

/**
 * How an admin corrects a wrong split decision: one act / split / merge-variant / rename.
 * The rows it writes are permanent `source='user'` rows the background identity task
 * never overrides, and the rescan runs **synchronously** so the modal can return
 * immediate feedback rather than leaving the user guessing.
 */
export const CompoundName: Story = {};

/** A spelling variant — the merge case ("La K'onga" into "La Konga"). */
export const SpellingVariant: Story = { args: { rawName: "La K'onga" } };

/** A real single act that must never be carved up, even though it contains a separator. */
export const AtomicBandName: Story = { args: { rawName: 'Die Toten Hosen' } };

/** A delimiter-less mash — the shape `segmentConcatenatedArtist` exists to split. */
export const ConcatenatedMash: Story = {
  args: { rawName: '2 MinutosTruenoDie Toten Hosen' },
};

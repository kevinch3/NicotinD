import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { TrackInfoSheetComponent } from './track-info-sheet.component';
import { storyProviders, type StoryState } from '../../../stories/support/story-providers';
import { demoSong } from '../../../stories/support/fixtures';
import type { Song } from '../../services/api/api-types';

/**
 * The per-track detail drawer: identity, technical facts, the analysis values
 * (BPM / key / perceptual axes), provenance, lyrics, and the curator actions.
 *
 * The analysis fields are all **optional** on `Song` — absent means "not
 * analysed yet", not zero. That distinction is the point of the two states
 * below: a library mid-backfill is the normal case, not an edge case, so the
 * sheet has to read sensibly when half the values are missing.
 */
const meta: Meta<TrackInfoSheetComponent> = {
  title: 'Components/TrackInfoSheet',
  component: TrackInfoSheetComponent,
  tags: ['autodocs'],
};
export default meta;

type Story = StoryObj<TrackInfoSheetComponent>;

const withState = (state: StoryState) => ({
  decorators: [
    applicationConfig({ providers: storyProviders(state) }),
    moduleMetadata({ imports: [TrackInfoSheetComponent] }),
  ],
});

/** Every enrichment task has run: perceptual axes, licence, the lot. */
const ANALYSED: Song = {
  ...demoSong,
  energy: 0.72,
  loudness: -8.4,
  valence: 0.61,
  danceability: 0.55,
  acousticness: 0.18,
  instrumental: 0.04,
  mood: 'dreamy',
  licence: 'cc-by-sa',
};

/**
 * The mid-backfill case: tags gave BPM and key, but nothing has run the
 * sidecar yet, so every perceptual axis is absent.
 */
const PARTIAL: Song = {
  ...demoSong,
  energy: undefined,
  valence: undefined,
  danceability: undefined,
  acousticness: undefined,
  mood: undefined,
  licence: undefined,
};

const args = (song: Song) => ({
  songId: song.id,
  song,
  displayTitle: song.title,
  displayArtist: song.artist,
  displayAlbum: song.album,
});

/** Fully analysed, viewed by an admin — every curator action is available. */
export const FullyAnalysed: Story = {
  ...withState({ role: 'admin' }),
  args: args(ANALYSED),
};

/**
 * Partially analysed. The absent axes must read as "not known yet" rather than
 * as a zero score — a 0.0 energy and an un-analysed track are very different
 * claims, and the radio engine treats them differently too.
 */
export const PartiallyAnalysed: Story = {
  ...withState({ role: 'admin' }),
  args: args(PARTIAL),
};

/**
 * A listener sees the same facts but none of the curation: no analyze/verify,
 * no identify-and-apply, no metadata edits. The gating is server-enforced as
 * well — this is the declutter half, not the security half.
 */
export const Listener: Story = {
  ...withState({ role: 'listener' }),
  args: args(ANALYSED),
};

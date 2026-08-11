import type { Meta, StoryObj } from '@storybook/angular';
import { TrackStatsBarsComponent } from './track-stats-bars.component';

const meta: Meta<TrackStatsBarsComponent> = {
  title: 'Components/TrackStatsBars',
  component: TrackStatsBarsComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The per-track analysis readout: tag-sourced BPM/key/genre alongside the Essentia perceptual axes and ebur128 energy. Every value is independently optional — enrichment is windowed, so a freshly landed track has tags long before it has perceptual axes, and a partially filled bar set is the normal mid-backfill state rather than an error.',
      },
    },
  },
  args: {
    bpm: 104,
    genre: 'Dream Pop',
    key: '8A',
    mood: 'relaxed',
    energy: 0.42,
    valence: 0.31,
    danceability: 0.55,
    acousticness: 0.68,
    instrumental: 0.22,
  },
};

export default meta;
type Story = StoryObj<TrackStatsBarsComponent>;

/** A fully enriched track: tags, Essentia perceptual axes and ebur128 energy all present. */
export const FullyAnalysed: Story = {};

export const HighEnergy: Story = {
  args: {
    bpm: 172,
    key: '11B',
    mood: 'aggressive',
    energy: 0.93,
    valence: 0.78,
    danceability: 0.88,
    acousticness: 0.05,
    instrumental: 0.11,
  },
};

export const AcousticAndQuiet: Story = {
  args: {
    bpm: 68,
    key: '4A',
    mood: 'relaxed',
    energy: 0.12,
    valence: 0.4,
    danceability: 0.18,
    acousticness: 0.95,
    instrumental: 0.83,
  },
};

/**
 * The partial state is the normal one mid-backfill: enrichment is windowed, so a freshly
 * landed track has tags long before it has perceptual axes.
 */
export const PartiallyAnalysed: Story = {
  args: {
    bpm: 104,
    genre: 'Dream Pop',
    key: null,
    mood: null,
    energy: null,
    valence: null,
    danceability: null,
    acousticness: null,
    instrumental: null,
  },
};

/** Nothing analysed — what an un-enriched or permanently-failed track looks like. */
export const NotAnalysed: Story = {
  args: {
    bpm: null,
    genre: null,
    key: null,
    mood: null,
    energy: null,
    valence: null,
    danceability: null,
    acousticness: null,
    instrumental: null,
  },
};

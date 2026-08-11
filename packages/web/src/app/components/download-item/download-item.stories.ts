import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { DownloadItemComponent } from './download-item.component';
import { storyProviders } from '../../../stories/support/story-providers';
import { demoDownloadItem } from '../../../stories/support/fixtures';

const meta: Meta<DownloadItemComponent> = {
  title: 'Components/DownloadItem',
  component: DownloadItemComponent,
  tags: ['autodocs'],
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: { item: demoDownloadItem, retrying: false },
};

export default meta;
type Story = StoryObj<DownloadItemComponent>;

/**
 * One job is one card. Card identity is the `jobId` the server recorded at enqueue time,
 * never a key re-derived from album metadata at read time — re-derivation is why a single
 * hunt used to split into five cards.
 */
export const Downloading: Story = {};

export const Queued: Story = {
  args: {
    item: { ...demoDownloadItem, stage: 'queued', percent: 0, progress: { done: 0, total: 7 } },
  },
};

export const Organizing: Story = {
  args: {
    item: {
      ...demoDownloadItem,
      stage: 'organizing',
      percent: 100,
      progress: { done: 7, total: 7 },
    },
  },
};

/** Scanned into the library but held behind the enrichment gates, so still not listable. */
export const Processing: Story = {
  args: {
    item: {
      ...demoDownloadItem,
      stage: 'processing',
      percent: 100,
      progress: { done: 7, total: 7 },
    },
  },
};

export const Done: Story = {
  args: {
    item: {
      ...demoDownloadItem,
      stage: 'done',
      percent: 100,
      progress: { done: 7, total: 7 },
      bitrateKbps: 192,
      audioFormat: 'opus',
      canRemove: true,
      canCancel: false,
      tracks: demoDownloadItem.tracks?.map((t) => ({ ...t, status: 'done' as const })),
    },
  },
};

/** An honest partial: the fallback gave up on some tracks rather than claiming success. */
export const PartialWithUnavailable: Story = {
  args: {
    item: {
      ...demoDownloadItem,
      stage: 'done',
      percent: 100,
      progress: { done: 5, total: 7 },
      unavailable: 2,
      canRetry: true,
      canRemove: true,
      canCancel: false,
    },
  },
};

export const Failed: Story = {
  args: {
    item: {
      ...demoDownloadItem,
      stage: 'error',
      error: 'No peer had the remaining 4 tracks',
      canRetry: true,
      canRemove: true,
      canCancel: false,
    },
  },
};

export const Retrying: Story = {
  args: {
    retrying: true,
    item: { ...demoDownloadItem, stage: 'error', error: 'Transfer stalled', canRetry: true },
  },
};

/** A URL acquire that landed across more than one album offers a "View N albums" menu. */
export const MultiAlbumAcquire: Story = {
  args: {
    item: {
      ...demoDownloadItem,
      kind: 'acquire',
      method: 'ytdlp',
      title: 'youtube.com/playlist?list=PL…',
      subtitle: undefined,
      stage: 'done',
      albumId: undefined,
      destinationAlbums: [
        {
          albumArtist: 'Nocturnal Signal',
          albumTitle: 'Static Bloom',
          albumId: 'album-static-bloom',
        },
        { albumArtist: 'Mira Oduya', albumTitle: 'Low Tide', albumId: 'album-low-tide' },
      ],
    },
  },
};

import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { expect, userEvent, within, waitFor } from 'storybook/test';
import { ArtistImageMenuComponent } from './artist-image-menu.component';
import { storyProviders, type StoryState } from '../../../stories/support/story-providers';
import { DEMO_ALBUM_ID } from '../../../stories/support/fixtures';
import type { Album } from '../../services/api/api-types';

/**
 * Curator control for an artist portrait: upload, copy from an album cover,
 * fetch automatically, or reset to the auto-resolved one.
 *
 * One component serves both the artist page and each Artists-grid tile — not a
 * copy, because a second one drifts on the busy-guard and the cache-bust (the
 * portrait URL is byte-identical after a change, so the bust is what makes the
 * new image appear at all).
 *
 * The stories **open the menu in a play function**. A static story would render
 * a lone `⋯` trigger and document nothing.
 */
const meta: Meta<ArtistImageMenuComponent> = {
  title: 'Components/ArtistImageMenu',
  component: ArtistImageMenuComponent,
  tags: ['autodocs'],
};
export default meta;

type Story = StoryObj<ArtistImageMenuComponent>;

const ALBUMS: Album[] = [
  { id: DEMO_ALBUM_ID, name: 'Static Bloom', artist: 'Nocturnal Signal', songCount: 9 },
  { id: 'album-second', name: 'Half Light EP', artist: 'Nocturnal Signal', songCount: 4 },
];

const openMenu = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByTestId('artist-image-menu-trigger'));
  await waitFor(() => expect(canvas.getByTestId('artist-image-upload')).toBeVisible());
};

const story = (state: StoryState, args: Story['args']): Story => ({
  decorators: [
    applicationConfig({ providers: storyProviders(state) }),
    moduleMetadata({ imports: [ArtistImageMenuComponent] }),
  ],
  args,
  play: async ({ canvasElement }) => openMenu(canvasElement),
});

/**
 * The artist page passes its albums, so "choose from album" can open its picker
 * immediately.
 */
export const WithAlbums = story(
  { role: 'admin', artistImageSources: ['lidarr', 'discogs'] },
  { artistId: 'artist-1', albums: ALBUMS },
);

/**
 * A grid tile passes none — they are fetched lazily on open, so the tile does
 * not pay for an album request it may never need.
 */
export const WithoutAlbums = story(
  { role: 'admin', artistImageSources: ['lidarr'] },
  { artistId: 'artist-1' },
);

/** The compact trigger used on an Artists-grid tile. */
export const Compact = story(
  { role: 'admin', artistImageSources: ['lidarr'] },
  { artistId: 'artist-1', albums: ALBUMS, compact: true },
);

/**
 * No configured source can resolve a portrait, so **Fetch automatically** is
 * disabled rather than offered and failing (issue #422). Upload and
 * copy-from-album still work — they need no provider.
 */
export const AutoFetchUnavailable: Story = {
  ...story({ role: 'admin', artistImageSources: [] }, { artistId: 'artist-1', albums: ALBUMS }),
  play: async ({ canvasElement }) => {
    await openMenu(canvasElement);
    const canvas = within(canvasElement);
    // Asserted on the control's own disabled state, not on a class: the point
    // is that it cannot be actioned, not that it looks dimmed.
    expect(canvas.getByTestId('artist-image-auto-fetch')).toBeDisabled();
    expect(canvas.getByTestId('artist-image-upload')).not.toBeDisabled();
  },
};

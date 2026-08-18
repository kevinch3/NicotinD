import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { SkeletonComponent } from './skeleton.component';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { TrackRowComponent } from '../track-row/track-row.component';
import { storyProviders } from '../../../stories/support/story-providers';
import { demoTracks } from '../../../stories/support/fixtures';

const meta: Meta<SkeletonComponent> = {
  title: 'Components/Skeleton',
  component: SkeletonComponent,
  tags: ['autodocs'],
  // The component itself injects nothing, but the shape-match stories render real
  // CoverArt / TrackRow alongside it — those do.
  decorators: [
    applicationConfig({ providers: storyProviders() }),
    moduleMetadata({ imports: [SkeletonComponent, CoverArtComponent, TrackRowComponent] }),
  ],
  argTypes: {
    variant: {
      control: 'select',
      options: [
        'album-tile',
        'artist-tile',
        'genre-tile',
        'track-row',
        'shelf-tile',
        'detail-header',
        'artist-header',
      ],
    },
    count: { control: { type: 'number', min: 1, max: 60 } },
  },
};

export default meta;
type Story = StoryObj<SkeletonComponent>;

/**
 * The Albums / Singles / Compilations grid, and the artist discography.
 *
 * Motion is a gentle opacity pulse (1 → 0.6 over 1.8s, `ease-in-out`) — shallower
 * and smoother than Tailwind's `animate-pulse`, which dwells at its trough and reads
 * as a flash. Every placeholder mounted in the same change-detection pass shares a
 * start time, so the grid breathes in lockstep rather than shimmering at random.
 *
 * Two states are real but not separately storyable: the pulse is disabled under
 * `prefers-reduced-motion` (check it with DevTools → Rendering → *Emulate CSS
 * prefers-reduced-motion*) and frozen on the **E-Ink** theme, which you *can* switch
 * to with the Theme toolbar above — e-paper ghosts on repaint. Faking either with a
 * story-level override would misrepresent what the stylesheet does.
 */
export const AlbumGrid: Story = { args: { variant: 'album-tile' } };

export const ArtistGrid: Story = { args: { variant: 'artist-tile' } };

export const GenreGrid: Story = { args: { variant: 'genre-tile' } };

/** Every song listing: album, playlist, genre, artist Songs and the Library Songs tab. */
export const TrackList: Story = { args: { variant: 'track-row' } };

/** The album page passes `[showCover]="false"` to its real rows, so its skeleton must too. */
export const TrackListWithoutCover: Story = {
  args: { variant: 'track-row', count: 5, trackCover: false },
};

/** The horizontally-scrolling "Recently played" shelf on the home page. */
export const Shelf: Story = { args: { variant: 'shelf-tile' } };

/** Album, playlist and share pages. Renders once regardless of `count`. */
export const DetailHeader: Story = { args: { variant: 'detail-header' } };

/** The artist page's round portrait + name block. */
export const ArtistHeader: Story = { args: { variant: 'artist-header' } };

/**
 * **The load-bearing story.** Real tiles on the left, the skeleton on the right, in
 * identical grid containers.
 *
 * The whole point of shape-matching is that the layout does not jump when data
 * lands, and that is only true if each text placeholder is a short bar centred in a
 * box of the *real* element's line-height (`text-sm` = 20px, `text-xs` = 16px)
 * rather than a bar of arbitrary height. Rows on both sides should terminate at the
 * same y-offset; if they drift, the ledger is wrong and this is where you see it.
 */
export const ShapeMatchAlbumGrid: Story = {
  render: () => ({
    props: { albums: demoTracks.slice(0, 4) },
    template: `
      <div class="grid grid-cols-2 gap-8">
        <div>
          <h3 class="text-xs uppercase tracking-wide text-theme-muted mb-2">Loaded</h3>
          <div class="grid grid-cols-2 gap-4">
            @for (a of albums; track a.id) {
              <div class="p-3 rounded-lg bg-theme-surface/30">
                <app-cover-art [artist]="a.artist" [album]="a.album ?? ''" [fill]="true" rounded="rounded" className="mb-2" />
                <p class="text-sm text-theme-primary truncate">{{ a.album }}</p>
                <p class="text-xs text-theme-muted truncate">{{ a.artist }} · 2024</p>
              </div>
            }
          </div>
        </div>
        <div>
          <h3 class="text-xs uppercase tracking-wide text-theme-muted mb-2">Loading</h3>
          <app-skeleton variant="album-tile" [count]="4" containerClass="grid grid-cols-2 gap-4" />
        </div>
      </div>`,
  }),
};

/**
 * The same check for song lists: real rows above, skeleton rows below, inside one
 * `space-y-0.5` stack so the 52px row pitch is directly comparable. A mismatch here
 * means a track list will visibly shift as it loads.
 */
export const ShapeMatchTrackList: Story = {
  render: () => ({
    props: { tracks: demoTracks.slice(0, 3) },
    template: `
      <div class="space-y-0.5">
        @for (t of tracks; track t.id) {
          <app-track-row [track]="t" [duration]="t.duration" />
        }
        <app-skeleton variant="track-row" [count]="3" />
      </div>`,
  }),
};

/** `count` scales a variant to the space it is standing in for. */
export const Counts: Story = {
  render: () => ({
    template: `
      <div class="space-y-6">
        @for (n of [3, 6, 12]; track n) {
          <div>
            <h3 class="text-xs uppercase tracking-wide text-theme-muted mb-2">count = {{ n }}</h3>
            <app-skeleton variant="album-tile" [count]="n" />
          </div>
        }
      </div>`,
  }),
};

/**
 * The two accessibility treatments, which are mutually exclusive by construction.
 *
 * A **labelled** skeleton is a `role="status"` live region named by `aria-label` —
 * the subtree stays textless on purpose, since a clipped `.sr-only` string is exactly
 * what an axe contrast check reports as incomplete. An **unlabelled** one is
 * decorative and `aria-hidden`. When a page shows two skeletons (a header plus its
 * list) only the first is labelled, so two live regions never compete for the
 * screen reader.
 */
export const LabelledAndDecorative: Story = {
  render: () => ({
    template: `
      <div class="space-y-6">
        <div>
          <h3 class="text-xs uppercase tracking-wide text-theme-muted mb-2">Labelled — role="status"</h3>
          <app-skeleton variant="album-tile" [count]="3" label="Loading albums" />
        </div>
        <div>
          <h3 class="text-xs uppercase tracking-wide text-theme-muted mb-2">Unlabelled — aria-hidden</h3>
          <app-skeleton variant="album-tile" [count]="3" />
        </div>
      </div>`,
  }),
};

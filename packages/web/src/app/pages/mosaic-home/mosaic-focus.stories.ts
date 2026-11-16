import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular-vite';
import { MosaicFocusComponent } from './mosaic-focus.component';
import type { FocusPreview } from '../../lib/mosaic-focus';
import { storyProviders } from '../../../stories/support/story-providers';

const tracks = (n: number): FocusPreview['tracks'] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    title: ['Paper Lanterns', 'Neon Ferry', 'Last Tram Home', 'Linen', 'Low Sun'][i % 5],
    artist: ['Marea Baja', 'North Arcade', 'Pale Atlas', 'Sister Meridian', 'Grey Parade'][i % 5],
  }));

const COVER = 'linear-gradient(160deg, #f97316, #ef4444)';

const meta: Meta<MosaicFocusComponent> = {
  title: 'Components/MosaicFocus',
  component: MosaicFocusComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The mosaic tile a tap brought forward: the only tile that can start anything. It carries Play, a short tag saying where the tile comes from, and ⋯; a playlist, genre or vibe also lists the first three tracks it would play, with Shuffle when there are others to draw. See docs/mosaic-tile-focus-design.md.',
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
  render: (args) => ({
    props: args,
    template: `<div style="position:relative;height:460px">
      <app-mosaic-focus style="top:24px" [title]="title" [subtitle]="subtitle" [background]="background"
        [gradientClass]="gradientClass" [emoji]="emoji" [tagKey]="tagKey" [preview]="preview"
        [side]="side" [busy]="busy" [hasMenu]="hasMenu" />
    </div>`,
  }),
  args: {
    title: 'Harbor Lights',
    subtitle: 'The Lowtide Choir · Northern Piers',
    background: COVER,
    gradientClass: '',
    emoji: '',
    tagKey: 'mosaic.tag.keepVibe',
    preview: { status: 'none', tracks: [] },
    side: 234,
    busy: false,
    hasMenu: true,
  },
};

export default meta;
type Story = StoryObj<MosaicFocusComponent>;

export const Song: Story = {};

export const PlaylistReady: Story = {
  args: {
    title: 'Late Shift',
    subtitle: '48 songs',
    tagKey: 'mosaic.tag.playlist',
    preview: { status: 'ready', tracks: tracks(8) },
  },
};

export const VibeLoading: Story = {
  args: {
    title: 'Focus',
    subtitle: 'Vibe',
    background: '',
    gradientClass: 'bg-gradient-to-br from-sky-500 to-indigo-600 text-white',
    emoji: '🎧',
    tagKey: 'mosaic.tag.vibe',
    preview: { status: 'loading', tracks: [] },
    hasMenu: true,
  },
};

export const GenreEmpty: Story = {
  args: {
    title: 'Post-punk',
    subtitle: '0 songs',
    background: '',
    gradientClass: 'bg-theme-surface-2 text-theme-secondary',
    tagKey: 'mosaic.tag.genre',
    preview: { status: 'empty', tracks: [] },
  },
};

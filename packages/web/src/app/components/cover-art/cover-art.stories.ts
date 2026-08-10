import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { CoverArtComponent } from './cover-art.component';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<CoverArtComponent> = {
  title: 'Components/CoverArt',
  component: CoverArtComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The single cover-image component. Resolution order is override → canonical → folder → embedded, with sized WebP thumbnails honouring `size`. With no usable cover it draws a placeholder whose gradient angle is `hash(artist:album) % 360` — deterministic per album, so a grid of coverless tiles is not a wall of identical squares — in theme tokens, so it restyles with the theme. Covers are `loading="lazy"` unless `eager` is set.',
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: { artist: 'Nocturnal Signal', album: 'Static Bloom', size: 160 },
};

export default meta;
type Story = StoryObj<CoverArtComponent>;

/**
 * With no `src` — or a `src` that 404s, as here, since Storybook serves no covers — the
 * component draws its placeholder. The gradient angle is `hash(artist:album) % 360`, so
 * it is deterministic per album and a grid of coverless tiles is not a flat wall of
 * identical squares. The colours are theme tokens, so it restyles with the theme picker.
 */
export const Placeholder: Story = {};

export const PlaceholderVariety: Story = {
  render: () => ({
    props: {
      albums: [
        { artist: 'Nocturnal Signal', album: 'Static Bloom' },
        { artist: 'Mira Oduya', album: 'Low Tide' },
        { artist: 'Halden Ross', album: 'Winter Count' },
        { artist: 'The Quiet Hours', album: 'Nightjar' },
        { artist: 'Ana Vela', album: 'Bruma' },
      ],
    },
    template: `
      <div class="flex flex-wrap gap-3">
        @for (a of albums; track a.album) {
          <app-cover-art [artist]="a.artist" [album]="a.album" [size]="120" />
        }
      </div>`,
  }),
};

export const Sizes: Story = {
  render: () => ({
    template: `
      <div class="flex items-end gap-3">
        @for (s of [40, 64, 96, 160, 240]; track s) {
          <app-cover-art artist="Nocturnal Signal" album="Static Bloom" [size]="s" />
        }
      </div>`,
  }),
};

/** `fill` drops the fixed size and expands to the container — used by Now Playing. */
export const Fill: Story = {
  render: () => ({
    template: `
      <div class="h-64 w-64">
        <app-cover-art artist="Nocturnal Signal" album="Static Bloom" [fill]="true" />
      </div>`,
  }),
};

export const Circular: Story = { args: { rounded: 'rounded-full', size: 120 } };

/**
 * Covers are `loading="lazy"` by default so a grid does not fire dozens of eager
 * requests. Pass `eager` only above the fold.
 */
export const Eager: Story = { args: { eager: true } };

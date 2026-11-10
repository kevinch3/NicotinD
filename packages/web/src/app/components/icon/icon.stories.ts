import type { Meta, StoryObj } from '@storybook/angular';
import { IconComponent, type IconName } from './icon.component';

/**
 * Every glyph the set ships, in declaration order. A `Record<IconName, true>`, so a
 * glyph added to `IconName` and left out here fails the type check instead of
 * silently missing from the AllIcons grid and the `name` control.
 */
const ICON_SET = {
  back: true,
  play: true,
  download: true,
  share: true,
  close: true,
  add: true,
  delete: true,
  queue: true,
  edit: true,
  tag: true,
  palette: true,
  headphones: true,
  user: true,
  mail: true,
  sliders: true,
  speaker: true,
  smartphone: true,
  monitor: true,
  wifi: true,
  activity: true,
  wrench: true,
  database: true,
  mic: true,
  camera: true,
  search: true,
  sort: true,
  'arrow-up': true,
  'check-square': true,
  music: true,
  'disc-album': true,
  disc: true,
  layers: true,
  'mic-vocal': true,
  'list-music': true,
  chart: true,
  'layout-grid': true,
  'rows-3': true,
  folder: true,
} satisfies Record<IconName, true>;

export const ICON_NAMES = Object.keys(ICON_SET) as IconName[];

const meta: Meta<IconComponent> = {
  title: 'Components/Icon',
  component: IconComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The centralized set of universal-action glyphs used on icon-only buttons. Before it, each glyph was a hand-copied inline `<svg>` (Back lived in three files). The icon is decorative (`aria-hidden`) — the *button* carries the accessible name via `aria-label`/`title`. Glyphs are lucide-style so the `[data-theme=eink] svg` stroke-thickening rule has one shape to thicken.',
      },
    },
  },
  argTypes: { name: { control: 'select', options: ICON_NAMES } },
  args: { name: 'play', size: 18 },
};

export default meta;
type Story = StoryObj<IconComponent>;

export const Default: Story = {};

export const Sizes: Story = {
  render: () => ({
    template: `
      <div class="flex items-end gap-4 text-theme-primary">
        @for (s of [14, 18, 24, 32, 48]; track s) {
          <div class="flex flex-col items-center gap-1">
            <app-icon name="headphones" [size]="s" />
            <span class="text-xs text-theme-muted">{{ s }}</span>
          </div>
        }
      </div>`,
  }),
};

/**
 * The whole set. Switch the theme toolbar to **E-Ink** here: `[data-theme=eink] svg`
 * thickens every stroke, and this grid is the only place that rule is reviewable.
 */
export const AllIcons: Story = {
  render: () => ({
    props: { names: ICON_NAMES },
    template: `
      <div class="grid grid-cols-4 gap-4 text-theme-primary sm:grid-cols-6">
        @for (n of names; track n) {
          <div class="flex flex-col items-center gap-2 rounded-lg border border-theme p-3">
            <app-icon [name]="n" [size]="24" />
            <span class="text-[11px] text-theme-muted">{{ n }}</span>
          </div>
        }
      </div>`,
  }),
};

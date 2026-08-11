import type { Meta, StoryObj } from '@storybook/angular';
import { IconComponent, type IconName } from './icon.component';

/** Every glyph the set ships, in declaration order. */
export const ICON_NAMES: IconName[] = [
  'back',
  'play',
  'download',
  'share',
  'close',
  'add',
  'delete',
  'queue',
  'edit',
  'tag',
  'palette',
  'headphones',
  'user',
  'sliders',
  'speaker',
  'smartphone',
  'monitor',
  'wifi',
  'activity',
  'wrench',
  'database',
  'mic',
  'camera',
];

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

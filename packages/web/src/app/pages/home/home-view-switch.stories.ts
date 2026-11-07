import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import type { HomeView } from '@nicotind/core';
import { HomeViewSwitchComponent } from './home-view-switch.component';
import { homeSwitchAnchorClass } from './home-switch-anchor';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<HomeViewSwitchComponent> = {
  title: 'Components/HomeViewSwitch',
  component: HomeViewSwitchComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The Shelves | Mosaic switch on the home route. A radiogroup on the Library-tab pattern: every option shows its icon, only the active one its label; the inactive label stays as `sr-only` so both radios keep their accessible names. The home shell mounts it once, outside the view swap, top-left on the header content edge.',
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: { view: 'mosaic' },
};

export default meta;
type Story = StoryObj<HomeViewSwitchComponent>;

export const Mosaic: Story = {};

export const Shelves: Story = { args: { view: 'shelves' } };

/**
 * The switch inside the home shell's `home-view-switch-anchor` wrapper (#1667), with a
 * stand-in for each view: the mosaic's `absolute inset-0` stage the anchor overlays,
 * and the shelves' first block it pushes down. The wrapper markup mirrors
 * `home.component.html`; `HomeComponent` itself is not mounted, because its loaders
 * would pull both lazy view chunks into the Storybook build.
 */
function anchored(view: HomeView): Story {
  const stage =
    view === 'mosaic'
      ? '<div class="absolute inset-0 flex items-center justify-center bg-theme-surface text-sm text-theme-muted">mosaic stage</div>'
      : '<div class="mx-auto max-w-3xl px-4 pt-4"><div class="rounded-xl bg-theme-surface-2 p-4 text-sm text-theme-muted">first shelf</div></div>';
  return {
    args: { view },
    parameters: { layout: 'fullscreen' },
    render: (args) => ({
      props: { ...args, anchorClass: homeSwitchAnchorClass(args.view ?? view) },
      template: `
        <div class="relative h-80 overflow-hidden bg-theme-base">
          <div data-testid="home-view-switch-anchor" [class]="anchorClass">
            <app-home-view-switch class="pointer-events-auto" [view]="view" />
          </div>
          ${stage}
        </div>`,
    }),
  };
}

export const AnchoredMosaic: Story = anchored('mosaic');

export const AnchoredShelves: Story = anchored('shelves');

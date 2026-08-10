import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { MenuPanelComponent } from './menu-panel.component';
import { storyProviders } from '../../../stories/support/story-providers';

const ITEMS = `
  <div menuPanel class="min-w-48 py-1">
    <button class="block w-full px-3 py-2 text-left text-sm hover:bg-theme-surface-2">Play next</button>
    <button class="block w-full px-3 py-2 text-left text-sm hover:bg-theme-surface-2">Add to queue</button>
    <button class="block w-full px-3 py-2 text-left text-sm hover:bg-theme-surface-2">Add to playlist…</button>
    <button class="block w-full px-3 py-2 text-left text-sm text-red-400 hover:bg-theme-surface-2">Remove</button>
  </div>`;

const meta: Meta<MenuPanelComponent> = {
  title: 'Components/MenuPanel',
  component: MenuPanelComponent,
  tags: ['autodocs'],
  decorators: [
    applicationConfig({ providers: storyProviders() }),
    moduleMetadata({ imports: [MenuPanelComponent] }),
  ],
  args: { align: 'end' },
  render: (args) => ({
    props: args,
    template: `
      <app-menu-panel [align]="align" [panelTestId]="panelTestId">
        <button menuTrigger class="rounded px-3 py-2 text-theme-primary hover:bg-theme-surface-2">⋯</button>
        ${ITEMS}
      </app-menu-panel>`,
  }),
};

export default meta;
type Story = StoryObj<MenuPanelComponent>;

/**
 * The panel is fixed-position and placed by the pure `computeMenuPosition`, which flips
 * above the trigger and clamps into the viewport. It reserves a `bottomInset` measured
 * from `data-bottom-chrome` layers, so it can never open underneath the mini-player or
 * the mobile tab bar.
 */
export const AlignEnd: Story = {};

export const AlignStart: Story = { args: { align: 'start' } };

/**
 * Near the bottom of the viewport the panel flips upward instead of overflowing. Open the
 * menu here to see it; this is the behaviour `computeMenuPosition` exists for.
 */
export const NearViewportBottom: Story = {
  render: (args) => ({
    props: args,
    template: `
      <div class="flex h-[85vh] items-end">
        <app-menu-panel [align]="align">
          <button menuTrigger class="rounded px-3 py-2 text-theme-primary hover:bg-theme-surface-2">⋯</button>
          ${ITEMS}
        </app-menu-panel>
      </div>`,
  }),
};

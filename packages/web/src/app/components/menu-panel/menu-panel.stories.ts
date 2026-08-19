import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { expect, userEvent, within, waitFor } from 'storybook/test';
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
  /**
   * Opens the menu and asserts the flip actually happened (issue #475).
   *
   * The assertion is on **geometry**, deliberately, not on a CSS class or a
   * style attribute: `computeMenuPosition` exists to keep the panel on screen,
   * and a class-based check would keep passing while the panel rendered off the
   * bottom of the viewport — which is the only failure anyone would care about.
   */
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: '⋯' });
    await userEvent.click(trigger);

    const panel = await waitFor(() => {
      const el = canvasElement.querySelector<HTMLElement>('[data-menu-panel-root]');
      if (!el) throw new Error('panel did not open');
      // Placement runs after a measure pass, so the panel is briefly hidden.
      if (getComputedStyle(el).visibility !== 'visible') throw new Error('not positioned yet');
      return el;
    });

    const panelBox = panel.getBoundingClientRect();
    const triggerBox = trigger.getBoundingClientRect();

    // Flipped: the panel's bottom edge is at or above the trigger's top edge.
    expect(panelBox.bottom).toBeLessThanOrEqual(triggerBox.top + 1);
    // And it is fully on screen, which is the property the flip is for.
    expect(panelBox.top).toBeGreaterThanOrEqual(0);
    expect(panelBox.bottom).toBeLessThanOrEqual(window.innerHeight);
  },
};

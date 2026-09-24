import { Component } from '@angular/core';
import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { EntityMenuButtonComponent } from './entity-menu-button.component';
import { EntityMenuHostComponent } from '../entity-menu-host/entity-menu-host.component';
import { storyProviders } from '../../../stories/support/story-providers';

/**
 * A tile as the pages render one: `group relative` root, the ⋯ fading in on
 * hover/focus, the one entity menu host beside it so a click opens for real.
 */
@Component({
  standalone: true,
  imports: [EntityMenuButtonComponent, EntityMenuHostComponent],
  template: `
    <div class="group relative w-40 p-3 rounded-lg bg-theme-surface/30 hover:bg-theme-surface-2/50">
      <app-entity-menu-button [actions]="actions" />
      <div class="aspect-square rounded bg-theme-surface-2 mb-2"></div>
      <p class="text-sm text-theme-primary truncate">Meddle</p>
      <p class="text-xs text-theme-muted truncate">Pink Floyd · 1971</p>
    </div>
    <app-entity-menu-host />
  `,
})
class TileHostComponent {
  actions = () => [
    { label: 'Start radio', labelKey: 'entityMenu.startRadio', action: () => {} },
    { label: 'Play', labelKey: 'entityMenu.play', action: () => {} },
    { label: 'Open', labelKey: 'entityMenu.open', action: () => {} },
  ];
}

const meta: Meta<TileHostComponent> = {
  title: 'Components/EntityMenuButton',
  component: TileHostComponent,
  tags: ['autodocs'],
  decorators: [
    applicationConfig({ providers: storyProviders() }),
    moduleMetadata({ imports: [TileHostComponent] }),
  ],
};

export default meta;
type Story = StoryObj<TileHostComponent>;

/** Hover the tile (or Tab to the ⋯) to reveal it; click opens the entity menu. */
export const OnATile: Story = {};

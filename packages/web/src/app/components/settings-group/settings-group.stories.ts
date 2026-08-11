import { moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { SettingsGroupComponent } from './settings-group.component';

const meta: Meta<SettingsGroupComponent> = {
  title: 'Components/SettingsGroup',
  component: SettingsGroupComponent,
  tags: ['autodocs'],
  decorators: [moduleMetadata({ imports: [SettingsGroupComponent] })],
  args: {
    icon: 'sliders',
    title: 'Playback',
    description: 'How audio behaves on this device',
    groupId: 'storybook-playback',
    defaultOpen: false,
  },
  render: (args) => ({
    props: args,
    template: `
      <app-settings-group
        [icon]="icon" [title]="title" [description]="description"
        [groupId]="groupId" [defaultOpen]="defaultOpen">
        <div class="space-y-3 text-sm text-theme-secondary">
          <label class="flex items-center justify-between gap-4">
            <span>Resume playback on load</span>
            <input type="checkbox" />
          </label>
          <label class="flex items-center justify-between gap-4">
            <span>Transcode to Opus</span>
            <input type="checkbox" checked />
          </label>
        </div>
      </app-settings-group>`,
  }),
};

export default meta;
type Story = StoryObj<SettingsGroupComponent>;

/**
 * Collapsed is the only correct default. Every settings-family view ships collapsed on
 * load with no exceptions, and `tests/settings-consistency.spec.ts` gates it in CI.
 */
export const Collapsed: Story = {};

/**
 * `defaultOpen` exists but is rarely right. If the card needs to do work when it opens
 * (minting a pairing code, starting a status poll), listen to the `opened` output
 * instead — that is what keeps the work off the page load.
 */
export const Expanded: Story = { args: { defaultOpen: true } };

export const WithoutDescription: Story = {
  args: { description: '', title: 'Advanced', icon: 'wrench', defaultOpen: true },
};

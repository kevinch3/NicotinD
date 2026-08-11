import type { Meta, StoryObj } from '@storybook/angular';
import { SettingsGroupHeaderComponent } from './settings-group-header.component';

const meta: Meta<SettingsGroupHeaderComponent> = {
  title: 'Components/SettingsGroupHeader',
  component: SettingsGroupHeaderComponent,
  tags: ['autodocs'],
  args: { icon: 'sliders', title: 'Playback', description: 'How audio behaves on this device' },
};

export default meta;
type Story = StoryObj<SettingsGroupHeaderComponent>;

export const Default: Story = {};
export const WithoutDescription: Story = { args: { description: '' } };
export const LongDescription: Story = {
  args: {
    icon: 'database',
    title: 'Library processing',
    description:
      'Background enrichment runs inside a daily window. Tasks that never produce a confident result are ledgered rather than retried forever.',
  },
};

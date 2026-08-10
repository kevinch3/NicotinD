import type { Meta, StoryObj } from '@storybook/angular';
import { IconComponent } from './icon.component';

const meta: Meta<IconComponent> = {
  title: 'Components/Icon',
  component: IconComponent,
  tags: ['autodocs'],
  args: { name: 'play', size: 18 },
};

export default meta;
type Story = StoryObj<IconComponent>;

export const Default: Story = {};

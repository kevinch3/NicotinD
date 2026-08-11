import type { Meta, StoryObj } from '@storybook/angular';
import { DiskPillComponent } from './disk-pill.component';

const TB = 1_000_000_000_000;

const meta: Meta<DiskPillComponent> = {
  title: 'Components/DiskPill',
  component: DiskPillComponent,
  tags: ['autodocs'],
  args: { used: 0.41 * TB, total: TB },
};

export default meta;
type Story = StoryObj<DiskPillComponent>;

export const Default: Story = {};

/** The fill shifts green → amber → red as the music dir fills up. */
export const Filling: Story = { args: { used: 0.78 * TB, total: TB } };

export const NearlyFull: Story = { args: { used: 0.96 * TB, total: TB } };

export const Empty: Story = { args: { used: 0.01 * TB, total: TB } };

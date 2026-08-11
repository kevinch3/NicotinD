import type { Meta, StoryObj } from '@storybook/angular';
import { SourceChipComponent } from './source-chip.component';

const meta: Meta<SourceChipComponent> = {
  title: 'Components/SourceChip',
  component: SourceChipComponent,
  tags: ['autodocs'],
  args: { source: 'soulseek', label: 'Soulseek' },
};

export default meta;
type Story = StoryObj<SourceChipComponent>;

/**
 * The chip is the neutral source marker in the blended acquisition list: every result
 * from every source renders in one ranked list with one Get, and the chip is the only
 * thing that says where it came from.
 */
export const Soulseek: Story = {};
export const InternetArchive: Story = { args: { source: 'archive', label: 'Internet Archive' } };
export const Spotify: Story = { args: { source: 'spotify', label: 'Spotify' } };
export const YouTube: Story = { args: { source: 'youtube', label: 'YouTube' } };
export const SoundCloud: Story = { args: { source: 'soundcloud', label: 'SoundCloud' } };
export const Bandcamp: Story = { args: { source: 'bandcamp', label: 'Bandcamp' } };
export const GenericLink: Story = { args: { source: 'link', label: 'Link' } };

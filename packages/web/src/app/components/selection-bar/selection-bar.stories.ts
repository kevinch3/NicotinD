import type { Meta, StoryObj } from '@storybook/angular';
import { SelectionBarComponent } from './selection-bar.component';

const meta: Meta<SelectionBarComponent> = {
  title: 'Components/SelectionBar',
  component: SelectionBarComponent,
  tags: ['autodocs'],
  args: { count: 3, total: 47, canPlay: true, canQueue: true },
};

export default meta;
type Story = StoryObj<SelectionBarComponent>;

/** One bar backs every multi-select surface, paired with `createSelection()`. */
export const Default: Story = {};

export const SingleSelected: Story = { args: { count: 1 } };

export const AllSelected: Story = { args: { count: 47 } };

/** Delete is admin/curator-gated, so most surfaces render the bar without it. */
export const WithDelete: Story = {
  args: { canDelete: true, deleteLabel: 'Delete 3 songs' },
};

export const EveryAction: Story = {
  args: {
    canPlay: true,
    canQueue: true,
    canDownload: true,
    canPreserve: true,
    canDelete: true,
    deleteLabel: 'Delete',
  },
};

/** Offline surfaces offer preserve/remove and nothing that needs the server. */
export const OfflineCapabilities: Story = {
  args: { canPlay: true, canQueue: true, canPreserve: true, canDownload: false },
};

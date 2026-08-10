import type { Meta, StoryObj } from '@storybook/angular';
import { ConfirmDialogComponent } from './confirm-dialog.component';

const meta: Meta<ConfirmDialogComponent> = {
  title: 'Components/ConfirmDialog',
  component: ConfirmDialogComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The confirmation modal itself. Reach it through `ConfirmService.ask()` rather than mounting it: that is what puts every destructive action behind one confirmation surface, one back-button contract (`registerOverlayCloser`) and one place to change the copy.',
      },
    },
  },
  args: { message: 'Delete “Static Bloom” and all 7 of its tracks?', confirmLabel: 'Delete' },
};

export default meta;
type Story = StoryObj<ConfirmDialogComponent>;

/**
 * Reached through `ConfirmService`, not by mounting it directly — that is what puts every
 * destructive action behind the same confirmation and the same `registerOverlayCloser`
 * back-button handling.
 */
export const Destructive: Story = {};

export const NonDestructive: Story = {
  args: {
    message: 'Rebuild the library from disk? Existing curation is preserved.',
    confirmLabel: 'Rescan',
  },
};

export const LongMessage: Story = {
  args: {
    message:
      'Merging “La K’onga” into “La Konga” re-mints the artist id. Portraits, uploaded images, bios and genre overrides are carried across automatically.',
    confirmLabel: 'Merge',
  },
};

import type { Meta, StoryObj } from '@storybook/angular';
import { ChangelogModalComponent } from './changelog-modal.component';

const meta: Meta<ChangelogModalComponent> = {
  title: 'Components/ChangelogModal',
  component: ChangelogModalComponent,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<ChangelogModalComponent>;

/**
 * Entries are baked in at build time: `scripts/build-changelog.ts` turns CHANGELOG.md
 * into `changelog.json`, capped at 50 versions. There are no inputs — the component
 * reads that bundle directly, so this story shows whatever the current build contains.
 *
 * Opened by clicking the version string in the header or in Settings.
 */
export const Default: Story = {};

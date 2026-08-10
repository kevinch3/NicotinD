import type { Meta, StoryObj } from '@storybook/angular';
import { PipelineStageBadgeComponent } from './pipeline-stage-badge.component';

const meta: Meta<PipelineStageBadgeComponent> = {
  title: 'Components/PipelineStageBadge',
  component: PipelineStageBadgeComponent,
  tags: ['autodocs'],
  args: { stage: 'downloading' },
};

export default meta;
type Story = StoryObj<PipelineStageBadgeComponent>;

export const Queued: Story = { args: { stage: 'queued' } };
export const Downloading: Story = {};
export const Organizing: Story = { args: { stage: 'organizing' } };
export const Scanning: Story = { args: { stage: 'scanning' } };

/**
 * `processing` means scanned into the library but still quarantined behind the
 * enrichment gates — the album exists but is hidden from every listing until its
 * required steps finish or permanently fail.
 */
export const Processing: Story = { args: { stage: 'processing' } };
export const Done: Story = { args: { stage: 'done' } };
export const Error: Story = { args: { stage: 'error' } };

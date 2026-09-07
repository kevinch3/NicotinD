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
export const Done: Story = { args: { stage: 'done' } };
export const Error: Story = { args: { stage: 'error' } };

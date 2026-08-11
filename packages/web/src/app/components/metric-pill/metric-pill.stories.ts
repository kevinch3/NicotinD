import type { Meta, StoryObj } from '@storybook/angular';
import { MetricPillComponent } from './metric-pill.component';

const GB = 1_073_741_824;

const meta: Meta<MetricPillComponent> = {
  title: 'Components/MetricPill',
  component: MetricPillComponent,
  tags: ['autodocs'],
  args: {
    cpu: { percent: 34, cores: 16, model: 'AMD Ryzen 7 5800X' },
    memory: {
      totalBytes: 32 * GB,
      usedBytes: 19 * GB,
      freeBytes: 13 * GB,
      processRssBytes: 512 * 1024 * 1024,
      processHeapBytes: 210 * 1024 * 1024,
    },
    gpu: null,
  },
};

export default meta;
type Story = StoryObj<MetricPillComponent>;

export const CpuAndMemory: Story = {};

export const CpuOnly: Story = { args: { memory: null, gpu: null } };

/**
 * The VRAM figure is the point of the GPU pill. TensorFlow never releases grown memory,
 * so the analysis sidecar can hold ~93 % of the card while reporting ~0 % utilisation —
 * a `percent`-only pill would show an idle card that no co-tenant can actually use.
 */
export const GpuHoldingVram: Story = {
  args: {
    gpu: {
      vendor: 'nvidia',
      percent: 2,
      name: 'Quadro P4000',
      memoryUsedBytes: 7631 * 1024 * 1024,
      memoryTotalBytes: 8192 * 1024 * 1024,
    },
  },
};

export const GpuBusy: Story = {
  args: {
    gpu: {
      vendor: 'nvidia',
      percent: 87,
      name: 'Quadro P4000',
      memoryUsedBytes: 7631 * 1024 * 1024,
      memoryTotalBytes: 8192 * 1024 * 1024,
    },
  },
};

/** Apple GPUs expose no utilisation, so `percent` is undefined rather than zero. */
export const GpuWithoutUtilisation: Story = {
  args: { gpu: { vendor: 'apple', name: 'Apple M2 Pro' } },
};

export const Loading: Story = { args: { cpu: null, memory: null, gpu: null } };

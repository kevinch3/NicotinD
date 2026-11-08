import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { ImportDropCardComponent, type ImportDropSummary } from './import-drop-card.component';
import { storyProviders } from '../../../stories/support/story-providers';

const SUMMARY: ImportDropSummary = {
  fileCount: 14,
  albumCount: 1,
  totalBytes: 412 * 1024 * 1024,
  skipped: [],
};

const WITH_SKIPPED: ImportDropSummary = {
  ...SUMMARY,
  skipped: ['Album/notes.nfo', 'Album/scans/booklet.psd', 'Album/._01 Intro.flac'],
};

const meta: Meta<ImportDropCardComponent> = {
  title: 'Components/ImportDropCard',
  component: ImportDropCardComponent,
  tags: ['autodocs'],
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: { state: 'manifest', summary: SUMMARY, percent: 0, error: null },
};

export default meta;
type Story = StoryObj<ImportDropCardComponent>;

/** A drop is a proposal: what was found, waiting for *Add to library*. */
export const Manifest: Story = {};

/** What the allowlist ignored, collapsed until asked for. */
export const ManifestWithSkipped: Story = { args: { summary: WITH_SKIPPED } };

export const Uploading: Story = { args: { state: 'uploading', percent: 42 } };

/** The bytes are up; the server has not taken the job yet. The bar is full, not stuck at 99. */
export const Committing: Story = { args: { state: 'committing', percent: 99 } };

export const Failed: Story = {
  args: { state: 'error', error: "That upload didn't finish." },
};

export const ManifestDaylight: Story = {
  args: { summary: WITH_SKIPPED },
  globals: { theme: 'Daylight' },
};

export const UploadingDaylight: Story = {
  args: { state: 'uploading', percent: 42 },
  globals: { theme: 'Daylight' },
};

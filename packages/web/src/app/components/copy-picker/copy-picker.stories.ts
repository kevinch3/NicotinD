import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { CopyPickerComponent } from './copy-picker.component';
import { storyProviders } from '../../../stories/support/story-providers';
import { folderToCopy, huntToCopy, mergeCopies } from '../../lib/copy-candidate';

const folder = (username: string, n: number, ext: string, free: boolean, queue = 0) =>
  folderToCopy(
    {
      username,
      directory: `Music\\Ennio Morricone\\The Best of Ennio Morricone (${username})`,
      uploadSpeed: 1,
      freeUploadSlots: free ? 1 : 0,
      queueLength: queue,
      files: Array.from({ length: n }, (_, i) => ({
        filename: `Music\\x\\${String(i + 1).padStart(2, '0')}.${ext}`,
        size: ext === 'flac' ? 21_000_000 : 7_000_000,
        bitRate: ext === 'mp3' ? 320 : undefined,
      })),
    },
    20,
  );

const meta: Meta<CopyPickerComponent> = {
  title: 'Components/CopyPicker',
  component: CopyPickerComponent,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Choose a copy: every copy the sources hold of one work, best first, the top one preselected. Each row carries the five facts that decide between copies — completeness, format, size, whether the peer is free, and who holds it. A drawer at the right on a wide screen, so the grid stays in view; a bottom sheet on a phone.',
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: {
    title: 'The Best of Ennio Morricone',
    artist: 'Ennio Morricone',
    status: '',
    copies: [
      folder('peer_alpha', 20, 'flac', true),
      folder('morricone_fan', 20, 'mp3', false, 3),
      folder('soundtracks', 18, 'flac', true),
    ],
  },
};

export default meta;
type Story = StoryObj<CopyPickerComponent>;

/** Copies the page search saw: no score yet. */
export const Unscored: Story = {};

/** A hunt scored some copies; they lead, the rest follow. */
export const Scored: Story = {
  args: {
    copies: mergeCopies(
      [
        huntToCopy({
          directory: 'Music\\Ennio Morricone\\The Best of Ennio Morricone [FLAC]',
          username: 'collector',
          files: [],
          matchedTracks: 20,
          totalTracks: 20,
          matchPct: 100,
          format: 'FLAC',
          estimatedSizeMb: 412,
          isLive: false,
          freeUploadSlots: 1,
          queueLength: 0,
          uploadSpeed: 1,
        }),
      ],
      [folder('peer_alpha', 20, 'flac', true)],
    ),
  },
};

/** A Get for the album is running: picking replaces it. */
export const Replacing: Story = { args: { status: 'Downloading · 7/20', replaces: true } };

/** Nothing seen yet. */
export const Empty: Story = { args: { copies: [] } };

/** The hunt is still scoring: nothing yet, and the header says it is looking. */
export const Scoring: Story = { args: { copies: [], searching: true } };

/** The source throttled the hunt, so the list may be short. */
export const Incomplete: Story = {
  args: { notice: 'The source is busy, so this list may be incomplete. Try again in a moment.' },
};

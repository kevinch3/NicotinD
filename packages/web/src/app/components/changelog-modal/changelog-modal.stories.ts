import type { Meta, StoryObj } from '@storybook/angular-vite';
import { ChangelogModalComponent, type RawChangelogEntry } from './changelog-modal.component';

const meta: Meta<ChangelogModalComponent> = {
  title: 'Components/ChangelogModal',
  component: ChangelogModalComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The release-notes modal, opened by clicking the version string in the header or in Settings. Entries are baked in at build time: `scripts/build-changelog.ts` turns `CHANGELOG.md` into `changelog.json`, capped at 50 versions. It reads that bundle unless a `source` list is passed, which is how this story stays fixed across releases.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<ChangelogModalComponent>;

const REPO = 'https://github.com/kevinch3/NicotinD';
const FIXTURE: RawChangelogEntry[] = [
  {
    version: '0.8.2',
    date: '2026-01-02',
    compareUrl: `${REPO}/compare/v0.8.1...v0.8.2`,
    sections: [
      {
        title: 'Features',
        items: [
          `**library:** albums remember their cover ([#12](${REPO}/issues/12)) ([abc1234](${REPO}/commit/abc1234))`,
          `**web:** the queue scrolls to the playing track ([#14](${REPO}/issues/14)) ([def5678](${REPO}/commit/def5678))`,
        ],
      },
      {
        title: 'Bug Fixes',
        items: [
          `**player:** resume after a dropped stream ([#15](${REPO}/issues/15)) ([0a1b2c3](${REPO}/commit/0a1b2c3))`,
        ],
      },
    ],
  },
  {
    version: '0.8.1',
    date: '2026-01-01',
    compareUrl: `${REPO}/compare/v0.8.0...v0.8.1`,
    sections: [
      {
        title: 'Bug Fixes',
        items: [`**search:** keep the query on back ([#11](${REPO}/issues/11))`],
      },
    ],
  },
];

/** A fixed two-release list: the bundled one changes with every release and broke the baseline (#2037). */
export const Default: Story = { args: { source: FIXTURE } };

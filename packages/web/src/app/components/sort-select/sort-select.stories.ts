import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { SortSelectComponent } from './sort-select.component';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<SortSelectComponent> = {
  title: 'Components/SortSelect',
  component: SortSelectComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          "A list toolbar's sort control reduced to one icon: a native `<select>` sits transparently over the sort glyph, so a phone opens its own picker and the value stays a real form control. The optional direction toggle renders beside it. Labels are i18n keys.",
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: {
    options: [
      { value: 'newest', label: 'library.sortBy.recentlyAdded' },
      { value: 'title', label: 'library.sortBy.title' },
      { value: 'album', label: 'library.sortBy.album' },
    ],
    value: 'newest',
    label: 'library.sortLabel.songs',
    testId: 'library-songs-sort',
    direction: null,
  },
  render: (args) => ({
    props: args,
    template: `<div class="flex items-center gap-2"><app-sort-select [options]="options" [value]="value" [label]="label" [testId]="testId" [direction]="direction" directionTestId="story-sort-direction" /></div>`,
  }),
};

export default meta;
type Story = StoryObj<SortSelectComponent>;

/** Server-ordered lists (Albums, Songs) have no direction. */
export const Default: Story = {};

/** Client-sorted grids (Compilations, Singles, Artists, offline Songs) add the toggle. */
export const WithDirection: Story = {
  args: {
    options: [
      { value: 'name', label: 'library.sortBy.name' },
      { value: 'artist', label: 'library.sortBy.artist' },
      { value: 'year', label: 'library.sortBy.year' },
    ],
    value: 'name',
    label: 'library.sortLabel.compilations',
    testId: 'library-compilations-sort',
    direction: 'desc',
  },
};

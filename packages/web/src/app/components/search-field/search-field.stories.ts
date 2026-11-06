import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { SearchFieldComponent } from './search-field.component';
import { SortSelectComponent } from '../sort-select/sort-select.component';
import { LibraryFilterPanelComponent } from '../library-filter-panel/library-filter-panel.component';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<SearchFieldComponent> = {
  title: 'Components/SearchField',
  component: SearchFieldComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          "The list toolbar's search box. It takes whatever width the icon controls leave (`flex-1 min-w-0`) and carries an optional result count inside the field, so a Library toolbar is one row at phone width. Review the **Mobile** viewport in Spanish: those strings are the long ones.",
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: {
    value: '',
    placeholder: 'library.search.songsPlaceholder',
    label: 'library.search.songsLabel',
    testId: 'library-songs-search',
    hint: '',
  },
};

export default meta;
type Story = StoryObj<SearchFieldComponent>;

export const Default: Story = {};

export const WithCount: Story = {
  args: {
    value: 'mar',
    placeholder: 'library.search.placeholder',
    label: 'library.search.artistsLabel',
    hint: '3 matches',
  },
};

/** The whole Songs-tab row at 390 px: search, sort, filters (two active), select. */
export const InToolbarRow: Story = {
  parameters: { viewport: { defaultViewport: 'mobile' } },
  decorators: [moduleMetadata({ imports: [SortSelectComponent, LibraryFilterPanelComponent] })],
  render: (args) => ({
    props: {
      ...args,
      sortOptions: [
        { value: 'newest', label: 'library.sortBy.recentlyAdded' },
        { value: 'title', label: 'library.sortBy.title' },
      ],
    },
    template: `
      <div class="flex items-center gap-2" style="max-width: 358px">
        <app-search-field [placeholder]="placeholder" [label]="label" [testId]="testId" />
        <app-sort-select [options]="sortOptions" value="newest" label="library.sortLabel.songs" />
        <app-library-filter-panel [compact]="true" [filter]="{ starred: true, bpmMin: 90 }" />
      </div>`,
  }),
};

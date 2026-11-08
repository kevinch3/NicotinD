import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { ImportEntryComponent } from './import-entry.component';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<ImportEntryComponent> = {
  title: 'Components/ImportEntry',
  component: ImportEntryComponent,
  tags: ['autodocs'],
  decorators: [applicationConfig({ providers: storyProviders() })],
  args: { dragging: false },
};

export default meta;
type Story = StoryObj<ImportEntryComponent>;

/** The Add tab's secondary action: opens the folder picker. */
export const Idle: Story = {};

/** A folder is being dragged over the Add tab — the entry echoes the page-wide overlay. */
export const DragOver: Story = { args: { dragging: true } };

/** The same two states on a light theme, where an outline has the least contrast to spare. */
export const IdleDaylight: Story = { globals: { theme: 'Daylight' } };

export const DragOverDaylight: Story = { args: { dragging: true }, globals: { theme: 'Daylight' } };

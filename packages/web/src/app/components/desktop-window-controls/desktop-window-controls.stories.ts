import type { Meta, StoryObj } from '@storybook/angular';
import { DesktopWindowControlsComponent } from './desktop-window-controls.component';

const meta: Meta<DesktopWindowControlsComponent> = {
  title: 'Components/DesktopWindowControls',
  component: DesktopWindowControlsComponent,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<DesktopWindowControlsComponent>;

/**
 * Minimise / maximise / close for the Electron shell on Linux and Windows, which run
 * frameless. macOS keeps its native traffic lights via `titleBarStyle: 'hiddenInset'`
 * and never renders this.
 *
 * Outside Electron the IPC bridge is absent, so the buttons render but do nothing —
 * which is exactly what this story shows.
 */
export const Default: Story = {};

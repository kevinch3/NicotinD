import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { TvShellComponent } from './tv-shell.component';
import { storyProviders } from '../../../stories/support/story-providers';
import { demoTrack, demoTracks } from '../../../stories/support/fixtures';

const meta: Meta<TvShellComponent> = {
  title: 'Components/TvShell',
  component: TvShellComponent,
  tags: ['autodocs'],
  decorators: [applicationConfig({ providers: storyProviders() })],
};

export default meta;
type Story = StoryObj<TvShellComponent>;

/**
 * The 10-foot surface. Turn **TV build → On** in the toolbar to get `html.tv-build`,
 * which applies the overscan safe-area insets and the D-pad focus styling — otherwise
 * this renders as an ordinary page and the whole point is invisible.
 *
 * The TV is a route-level fork keyed off `isTvBuild()`, never `isTvUi()`: `app.routes.ts`
 * is evaluated before `applyTvBuildClass()` runs, so a DOM-based check there registers
 * nothing at all.
 */
export const Idle: Story = {};

export const Playing: Story = {
  decorators: [
    applicationConfig({
      providers: storyProviders({ currentTrack: demoTrack, isPlaying: true, queue: demoTracks }),
    }),
  ],
};

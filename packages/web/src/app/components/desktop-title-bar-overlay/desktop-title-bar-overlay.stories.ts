import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { DesktopTitleBarOverlayComponent } from './desktop-title-bar-overlay.component';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<DesktopTitleBarOverlayComponent> = {
  title: 'Components/DesktopTitleBarOverlay',
  component: DesktopTitleBarOverlayComponent,
  tags: ['autodocs'],
  decorators: [applicationConfig({ providers: storyProviders() })],
};

export default meta;
type Story = StoryObj<DesktopTitleBarOverlayComponent>;

/**
 * The fallback drag region for routes rendered *outside* the app shell — setup, login,
 * server picker, share. Inside the shell the `<header>` is the drag region instead.
 *
 * Without this, a frameless Linux/Windows Electron window is undraggable and unclosable
 * on first run, which is the only screen a new user sees.
 *
 * It renders nothing outside Electron, so this story is intentionally blank in a browser.
 */
export const Default: Story = {};

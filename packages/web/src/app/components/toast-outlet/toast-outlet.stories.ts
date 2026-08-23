import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { inject, provideAppInitializer } from '@angular/core';
import { ToastOutletComponent } from './toast-outlet.component';
import { ToastService } from '../../services/toast.service';
import { storyProviders } from '../../../stories/support/story-providers';

/** Seeds the real ToastService before the outlet mounts, so the story has content. */
function withToasts(seed: (toast: ToastService) => void) {
  return applicationConfig({
    providers: [...storyProviders(), provideAppInitializer(() => seed(inject(ToastService)))],
  });
}

const meta: Meta<ToastOutletComponent> = {
  title: 'Components/ToastOutlet',
  component: ToastOutletComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          "Mounted once in the app shell; renders `ToastService`'s queue. Capped at three: a fourth toast evicts the oldest non-countdown one, and if all three are countdowns the *new* toast is dropped instead — evicting a countdown would fire its `actions[0]` for a toast the user never saw.",
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
};

export default meta;
type Story = StoryObj<ToastOutletComponent>;

/**
 * The outlet is mounted once in the app shell; everything else calls `ToastService`.
 * Toasts are a lossy surface by design — anything that must survive being missed needs a
 * durable home too (the Downloads review inbox is the worked example).
 */
export const Empty: Story = {};

export const Success: Story = {
  decorators: [
    withToasts((t) => t.show({ kind: 'success', message: 'Added 7 songs to “Late night”' })),
  ],
};

export const Info: Story = {
  decorators: [
    withToasts((t) =>
      t.show({ kind: 'info', message: 'Already in your library — nothing to download' }),
    ),
  ],
};

export const ErrorToast: Story = {
  decorators: [withToasts((t) => t.show({ kind: 'error', message: 'Could not reach the server' }))],
};

export const WithAction: Story = {
  decorators: [
    withToasts((t) =>
      t.show({
        kind: 'info',
        message: 'A new version is ready',
        actions: [{ label: 'Reload', callback: () => undefined }],
      }),
    ),
  ],
};

/**
 * A countdown toast auto-fires `actions[0]` when it elapses. That is why the cap logic
 * drops a *new* toast rather than evicting a countdown: evicting one would fire an action
 * (an auto-download, say) for a toast the user never saw.
 */
export const Countdown: Story = {
  decorators: [
    withToasts((t) =>
      t.show({
        kind: 'info',
        message: 'Downloading best match in 5s',
        countdown: 5,
        actions: [{ label: 'Get it now', callback: () => undefined }],
      }),
    ),
  ],
};

/** Three is the cap (`MAX_TOASTS`); a fourth evicts the oldest non-countdown toast. */
export const AtCapacity: Story = {
  decorators: [
    withToasts((t) => {
      t.show({ kind: 'success', message: 'Portrait updated' });
      t.show({ kind: 'info', message: 'Rescan queued' });
      t.show({ kind: 'error', message: 'Lyrics source unavailable' });
    }),
  ],
};

import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular';
import { inject, provideAppInitializer } from '@angular/core';
import { ConfirmHostComponent } from './confirm-host.component';
import { ConfirmService } from '../../services/confirm.service';
import { storyProviders } from '../../../stories/support/story-providers';

const meta: Meta<ConfirmHostComponent> = {
  title: 'Components/ConfirmHost',
  component: ConfirmHostComponent,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Mounted once in the app shell; renders whatever `ConfirmService.request()` holds and nothing otherwise. One modal shared by every caller, instead of each page hand-rolling its own confirm.',
      },
    },
  },
  decorators: [applicationConfig({ providers: storyProviders() })],
};

export default meta;
type Story = StoryObj<ConfirmHostComponent>;

/** Idle: the host is mounted once in the shell and renders nothing until asked. */
export const Idle: Story = {};

/**
 * Every destructive action routes through `ConfirmService.ask()` rather than mounting a
 * dialog itself — one confirmation surface, one back-button contract, one place to change
 * the copy. `Remove` in the song menu is the canonical caller.
 */
export const Asking: Story = {
  decorators: [
    applicationConfig({
      providers: [
        ...storyProviders(),
        provideAppInitializer(() => {
          void inject(ConfirmService).ask(
            'Delete “Opening Static”? The file is removed from disk.',
          );
        }),
      ],
    }),
  ],
};

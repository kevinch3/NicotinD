import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular-vite';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { SongDetailComponent } from './song-detail.component';
import { storyProviders } from '../../../stories/support/story-providers';

const routeFor = (id: string) => {
  const paramMap = convertToParamMap({ id });
  return { provide: ActivatedRoute, useValue: { paramMap: of(paramMap), snapshot: { paramMap } } };
};

const meta: Meta<SongDetailComponent> = {
  title: 'Pages/SongDetail',
  component: SongDetailComponent,
  parameters: {
    docs: {
      description: {
        component:
          "A song's own page, so a song can be linked to and shared: cover, title, every credited artist and the album as links, year and duration, with Play, Start radio and the song's menu.",
      },
    },
  },
  decorators: [applicationConfig({ providers: [...storyProviders(), routeFor('song-page-demo')] })],
};

export default meta;
type Story = StoryObj<SongDetailComponent>;

export const Default: Story = {};

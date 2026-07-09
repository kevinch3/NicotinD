import { Component, input, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ArtistCredit } from '../../services/api/api-types';

interface Segment {
  type: 'link' | 'text';
  text: string;
  id?: string;
}

@Component({
  selector: 'app-artist-links',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './artist-links.component.html',
})
export class ArtistLinksComponent {
  readonly artists = input<ArtistCredit[]>();
  readonly fallbackArtist = input<string>();
  readonly fallbackArtistId = input<string>();

  readonly segments = computed<Segment[]>(() => {
    const list = this.artists();
    if (!list || list.length === 0) {
      const name = this.fallbackArtist();
      const id = this.fallbackArtistId();
      if (!name) return [];
      return id ? [{ type: 'link', text: name, id }] : [{ type: 'text', text: name }];
    }

    const primaries = list.filter((a) => a.role === 'primary');
    const featuring = list.filter((a) => a.role === 'featuring');
    const segments: Segment[] = [];

    for (let i = 0; i < primaries.length; i++) {
      if (i > 0) segments.push({ type: 'text', text: i === primaries.length - 1 ? ' & ' : ', ' });
      segments.push({ type: 'link', text: primaries[i].name, id: primaries[i].id });
    }

    if (featuring.length > 0) {
      segments.push({ type: 'text', text: ' feat. ' });
      for (let i = 0; i < featuring.length; i++) {
        if (i > 0) segments.push({ type: 'text', text: i === featuring.length - 1 ? ' & ' : ', ' });
        segments.push({ type: 'link', text: featuring[i].name, id: featuring[i].id });
      }
    }

    return segments;
  });
}

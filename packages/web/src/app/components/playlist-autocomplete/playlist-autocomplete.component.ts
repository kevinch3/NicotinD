import { Component, input, output, signal, computed, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { ApiService, Playlist } from '../../services/api.service';
import { firstValueFrom } from 'rxjs';

interface PlaylistOption {
  id: string;
  name: string;
  coverArt?: string;
}

@Component({
  selector: 'app-playlist-autocomplete',
  standalone: true,
  imports: [FormsModule, CoverArtComponent],
  templateUrl: './playlist-autocomplete.component.html',
  })
export class PlaylistAutocompleteComponent implements OnInit {
  private api = inject(ApiService);

  selected = output<string>();  // playlist id
  create = output<string>();    // new playlist name

  query = signal('');
  loading = signal(true);
  playlists = signal<PlaylistOption[]>([]);

  filtered = computed(() => {
    const q = this.query().toLowerCase().trim();
    if (!q) return this.playlists();
    return this.playlists().filter(p => p.name.toLowerCase().includes(q));
  });

  exactMatch = computed(() =>
    this.playlists().some(p => p.name.toLowerCase() === this.query().toLowerCase().trim())
  );

  async ngOnInit() {
    const raw = await firstValueFrom(this.api.getPlaylists());
    this.playlists.set(raw.map((pl: Playlist) => ({
      id: pl.id,
      name: pl.name,
      coverArt: pl.coverArt,
    })));
    this.loading.set(false);
  }

  select(pl: PlaylistOption) {
    this.selected.emit(pl.id);
  }

  createNew() {
    this.create.emit(this.query().trim());
  }
}

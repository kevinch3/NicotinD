import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PlaylistService } from '../../services/playlist.service';

/**
 * Global "Add to playlist" picker. Mounted once in the layout; it renders only
 * when `PlaylistService.pendingSongIds` is set (any track row opens it via
 * `openPicker([...])`). Lists existing playlists and offers an inline create.
 */
@Component({
  selector: 'app-add-to-playlist',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './add-to-playlist.component.html',
})
export class AddToPlaylistComponent {
  readonly playlists = inject(PlaylistService);

  readonly newName = signal('');
  readonly busy = signal(false);
  readonly creating = signal(false);

  async addTo(playlistId: string): Promise<void> {
    const ids = this.playlists.pendingSongIds();
    if (!ids || this.busy()) return;
    this.busy.set(true);
    try {
      await this.playlists.addSongs(playlistId, ids);
      this.close();
    } finally {
      this.busy.set(false);
    }
  }

  async createAndAdd(): Promise<void> {
    const ids = this.playlists.pendingSongIds();
    const name = this.newName().trim();
    if (!ids || !name || this.busy()) return;
    this.busy.set(true);
    try {
      await this.playlists.create(name, ids);
      this.newName.set('');
      this.creating.set(false);
      this.close();
    } finally {
      this.busy.set(false);
    }
  }

  close(): void {
    this.creating.set(false);
    this.newName.set('');
    this.playlists.closePicker();
  }
}

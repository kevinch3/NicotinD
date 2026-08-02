import { Component, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MenuPanelComponent } from '../menu-panel/menu-panel.component';
import { IconComponent } from '../icon/icon.component';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { AuthService } from '../../services/auth.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import type { Album } from '../../services/api/api-types';
import { BottomChromeSafeDirective } from '../../directives/bottom-chrome-safe.directive';

/**
 * The artist-portrait override control: upload / copy from an album cover /
 * auto-fetch / reset.
 *
 * why a component: this logic lived inline in `artist-detail.component`, so the
 * only way to give an artist a photo was to open that artist's page. Issue #250
 * gap 4 wants the same affordance on the Artists grid, and explicitly asks for
 * **one component, not a copy** — a second implementation would drift on the
 * cache-bust and the busy-guard, which are the two easy things to get wrong here.
 *
 * `albums` is optional: the artist page already has them loaded and passes them
 * (no extra request), while the grid has only a tile and lets the component
 * fetch them lazily the first time "Choose from album" is opened. That keeps the
 * grid's initial render free of N album requests it would almost never use.
 */
@Component({
  selector: 'app-artist-image-menu',
  standalone: true,
  imports: [MenuPanelComponent, IconComponent, CoverArtComponent, BottomChromeSafeDirective],
  templateUrl: './artist-image-menu.component.html',
})
export class ArtistImageMenuComponent {
  private readonly api = inject(LibraryApiService);
  readonly auth = inject(AuthService);

  readonly artistId = input.required<string>();
  /** Albums offered for "choose from album". Empty → fetched lazily on open. */
  readonly albums = input<Album[]>([]);
  /** Compact trigger for a grid tile vs the larger one on the artist page. */
  readonly compact = input(false);

  /** Emitted after any successful change so the host can bust its cover cache. */
  readonly changed = output<void>();

  readonly busy = signal(false);
  readonly albumPickerOpen = signal(false);
  readonly pickable = signal<Album[]>([]);
  readonly loadingAlbums = signal(false);

  readonly menu = viewChild<MenuPanelComponent>('menu');
  readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  private closeMenu(): void {
    this.menu()?.open.set(false);
  }

  triggerUpload(): void {
    this.closeMenu();
    this.fileInput()?.nativeElement.click();
  }

  async onFileSelected(event: Event): Promise<void> {
    const el = event.target as HTMLInputElement;
    const file = el.files?.[0];
    el.value = ''; // allow re-selecting the same file later
    if (!file) return;
    await this.run(() => firstValueFrom(this.api.uploadArtistImage(this.artistId(), file)));
  }

  async openAlbumPicker(): Promise<void> {
    this.closeMenu();
    const provided = this.albums();
    if (provided.length > 0) {
      this.pickable.set(provided);
      this.albumPickerOpen.set(true);
      return;
    }
    // Grid case: no albums to hand, so fetch them on demand rather than making
    // every tile pay for a request it probably never needs.
    this.loadingAlbums.set(true);
    this.albumPickerOpen.set(true);
    try {
      const res = await firstValueFrom(this.api.getArtist(this.artistId()));
      this.pickable.set([...(res.albums ?? []), ...(res.singlesAndEps ?? [])]);
    } catch {
      this.pickable.set([]);
    } finally {
      this.loadingAlbums.set(false);
    }
  }

  closeAlbumPicker(): void {
    this.albumPickerOpen.set(false);
  }

  async pickAlbumCover(albumId: string): Promise<void> {
    this.albumPickerOpen.set(false);
    await this.run(() =>
      firstValueFrom(this.api.setArtistImageFromAlbum(this.artistId(), albumId)),
    );
  }

  /** Resolve a portrait from the provider chain (lidarr → spotify → …). */
  async autoFetch(): Promise<void> {
    this.closeMenu();
    await this.run(() => firstValueFrom(this.api.autoFetchArtistImage(this.artistId())));
  }

  async reset(): Promise<void> {
    this.closeMenu();
    await this.run(() => firstValueFrom(this.api.resetArtistImage(this.artistId())));
  }

  /** Shared busy-guard + change notification for every action. */
  private async run(action: () => Promise<unknown>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await action();
      this.changed.emit();
    } catch {
      /* best-effort; the tile simply keeps its prior image */
    } finally {
      this.busy.set(false);
    }
  }
}

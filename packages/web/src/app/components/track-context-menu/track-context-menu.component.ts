import { Component, input, output, inject } from '@angular/core';
import { Router } from '@angular/router';

@Component({
  selector: 'app-track-context-menu',
  templateUrl: './track-context-menu.component.html',
  standalone: true,
})
export class TrackContextMenuComponent {
  private router = inject(Router);

  readonly artist = input.required<string>();
  readonly position = input.required<{ x: number; y: number }>();
  readonly trackId = input<string | undefined>(undefined);
  readonly close = output<void>();
  readonly openInfo = output<string>();

  searchArtist(): void {
    this.router.navigate(['/'], { queryParams: { q: this.artist() } });
    this.close.emit();
  }

  showTrackInfo(): void {
    const id = this.trackId();
    if (id) this.openInfo.emit(id);
    this.close.emit();
  }
}

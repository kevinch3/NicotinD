import { Component, input, output, inject, computed } from '@angular/core';
import { Router } from '@angular/router';
import { clampMenuPosition } from '../../lib/menu-position';

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

  // Keep the menu inside the viewport — a raw tap near the right/bottom edge
  // otherwise overflows off-screen on mobile (§G6).
  readonly menuPosition = computed(() =>
    clampMenuPosition(
      this.position(),
      typeof window !== 'undefined' ? window.innerWidth : 1024,
      typeof window !== 'undefined' ? window.innerHeight : 768,
    ),
  );

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

import { Component, input, output } from '@angular/core';
import { Router } from '@angular/router';
import { inject } from '@angular/core';

@Component({
  selector: 'app-track-context-menu',
  templateUrl: './track-context-menu.component.html',
  })
export class TrackContextMenuComponent {
  private router = inject(Router);

  readonly artist = input.required<string>();
  readonly position = input.required<{ x: number; y: number }>();
  readonly close = output<void>();

  searchArtist(): void {
    this.router.navigate(['/'], { queryParams: { q: this.artist() } });
    this.close.emit();
  }
}

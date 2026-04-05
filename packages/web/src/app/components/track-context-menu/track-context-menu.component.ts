import { Component, input, output } from '@angular/core';
import { Router } from '@angular/router';
import { inject } from '@angular/core';

@Component({
  selector: 'app-track-context-menu',
  template: `
    <div class="fixed inset-0 z-[70]" (click)="close.emit()"></div>
    <div class="fixed z-[80] bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl py-1 min-w-[180px]"
      [style.top.px]="position().y" [style.left.px]="position().x">
      <button (click)="searchArtist()" class="w-full text-left px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 transition">
        Search more by artist
      </button>
    </div>
  `,
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

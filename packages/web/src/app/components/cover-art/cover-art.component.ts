import { Component, input, signal } from '@angular/core';

const GRADIENTS: [string, string][] = [
  ['#6366f1', '#8b5cf6'],
  ['#ec4899', '#f43f5e'],
  ['#14b8a6', '#06b6d4'],
  ['#f59e0b', '#ef4444'],
  ['#10b981', '#14b8a6'],
  ['#3b82f6', '#6366f1'],
  ['#8b5cf6', '#d946ef'],
  ['#f97316', '#f59e0b'],
];

export function hashCode(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

@Component({
  selector: 'app-cover-art',
  template: `
    @if (src() && !imgError()) {
      <img
        [src]="src()"
        [alt]="album() || artist() || 'cover'"
        [width]="size()"
        [height]="size()"
        [class]="'object-cover ' + rounded() + ' ' + className()"
        [style.flex-shrink]="0"
        (error)="imgError.set(true)"
      />
    } @else {
      <div
        [class]="rounded() + ' flex items-center justify-center select-none ' + className()"
        [style.width.px]="size()"
        [style.height.px]="size()"
        [style.flex-shrink]="0"
        [style.background]="gradient"
      >
        <span
          [style.font-size.px]="size() * 0.35"
          [style.color]="'rgba(255,255,255,0.85)'"
          [style.font-weight]="700"
        >
          {{ initial }}
        </span>
      </div>
    }
  `,
})
export class CoverArtComponent {
  readonly src = input<string | undefined>(undefined);
  readonly artist = input('');
  readonly album = input('');
  readonly size = input.required<number>();
  readonly className = input('');
  readonly rounded = input('rounded');

  readonly imgError = signal(false);

  get gradient(): string {
    const [from, to] =
      GRADIENTS[hashCode(`${this.artist()}:${this.album()}`) % GRADIENTS.length];
    return `linear-gradient(135deg, ${from}, ${to})`;
  }

  get initial(): string {
    return (this.album() || this.artist() || '?')[0].toUpperCase();
  }
}

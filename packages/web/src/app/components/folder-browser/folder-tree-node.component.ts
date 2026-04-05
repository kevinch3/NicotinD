import { Component, input, output, signal } from '@angular/core';
import type { FolderNode } from '../../lib/folder-utils';

@Component({
  selector: 'app-folder-tree-node',
  template: `
    <div>
      <button
        (click)="toggle()"
        [class]="'w-full text-left flex items-center gap-1 px-2 py-1 rounded text-xs transition ' +
          (selected() === node().fullPath
            ? 'bg-zinc-700 text-zinc-100'
            : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200')">
        <span>{{ expanded() ? '▾' : '▸' }}</span>
        <span class="truncate">{{ node().segment }}</span>
      </button>
      @if (expanded() && node().children.length > 0) {
        <div class="pl-3">
          @for (child of node().children; track child.fullPath) {
            <app-folder-tree-node
              [node]="child"
              [selected]="selected()"
              (selectNode)="selectNode.emit($event)"
            />
          }
        </div>
      }
    </div>
  `,
})
export class FolderTreeNodeComponent {
  readonly node = input.required<FolderNode>();
  readonly selected = input.required<string>();
  readonly selectNode = output<string>();

  readonly expanded = signal(false);

  ngOnInit(): void {
    this.expanded.set(this.selected().startsWith(this.node().fullPath));
  }

  toggle(): void {
    this.expanded.update(v => !v);
    this.selectNode.emit(this.node().fullPath);
  }
}

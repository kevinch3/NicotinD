import { Component, input, output, signal } from '@angular/core';
import type { FolderNode } from '../../lib/folder-utils';

@Component({
  selector: 'app-folder-tree-node',
  templateUrl: './folder-tree-node.component.html',
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

import { Component, output } from '@angular/core';
import { registerOverlayCloser } from '../../services/native/back-button.service';
import { CommonModule } from '@angular/common';
import changelog from '../../../../public/changelog.json';
import { parseChangelogItem, type ParsedChangelogItem } from '../../lib/changelog';
import { BottomChromeSafeDirective } from '../../directives/bottom-chrome-safe.directive';

interface RawChangelogSection {
  title: string;
  items: string[];
}

interface RawChangelogEntry {
  version: string;
  date: string;
  compareUrl: string;
  sections: RawChangelogSection[];
}

interface ParsedSection {
  title: string;
  items: ParsedChangelogItem[];
}

interface ParsedEntry {
  version: string;
  date: string;
  compareUrl: string;
  sections: ParsedSection[];
}

@Component({
  selector: 'app-changelog-modal',
  standalone: true,
  imports: [CommonModule, BottomChromeSafeDirective],
  templateUrl: './changelog-modal.component.html',
})
export class ChangelogModalComponent {
  close = output<void>();

  readonly entries: ParsedEntry[] = (changelog as RawChangelogEntry[]).map((e) => ({
    version: e.version,
    date: e.date,
    compareUrl: e.compareUrl,
    sections: e.sections.map((s) => ({
      title: s.title,
      items: s.items.map(parseChangelogItem),
    })),
  }));

  constructor() {
    // Escape / hardware Back close via the shared stack (issue #398).
    registerOverlayCloser(() => this.close.emit());
  }
}

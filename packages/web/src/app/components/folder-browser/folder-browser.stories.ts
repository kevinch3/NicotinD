import { Component, effect, input, viewChild } from '@angular/core';
import { applicationConfig, moduleMetadata, type Meta, type StoryObj } from '@storybook/angular';
import { FolderBrowserComponent } from './folder-browser.component';
import { storyProviders } from '../../../stories/support/story-providers';
import type { BrowseDir, BrowseFile } from '../../lib/folder-utils';

/**
 * Host wrapper that seeds the browse result.
 *
 * `loadBrowse()` is user-triggered and early-returns when `dirs()` is already
 * set, so seeding is both safe and idempotent — the component will not refetch
 * over it. Going through the real fetch instead would mean every story sat on the
 * poll's 2500ms first-attempt delay before showing anything.
 */
@Component({
  selector: 'app-folder-browser-probe',
  standalone: true,
  imports: [FolderBrowserComponent],
  template: `
    <app-folder-browser
      username="peer-one"
      [matchedPath]="matchedPath()"
      [fallbackFiles]="fallbackFiles()"
    />
  `,
})
class FolderBrowserProbeComponent {
  readonly dirs = input<BrowseDir[] | null>(null);
  readonly matchedPath = input('');
  readonly fallbackFiles = input<BrowseFile[]>([]);
  readonly loading = input(false);
  readonly errorMsg = input<string | null>(null);
  private readonly browser = viewChild(FolderBrowserComponent);

  constructor() {
    effect(() => {
      const b = this.browser();
      if (!b) return;
      if (this.dirs()) b.dirs.set(this.dirs());
      b.loading.set(this.loading());
      if (this.errorMsg()) {
        b.error.set(true);
        b.errorMsg.set(this.errorMsg());
      }
    });
  }
}

/**
 * The raw Soulseek peer lane: browse a peer's shared folders and pick the one
 * to take.
 *
 * This is the **folder-first** view — a folder is the "get this album" unit, so
 * an album-intent query lands here rather than in a flat song list, where a
 * long blended list would bury the thing the user actually wants.
 */
const meta: Meta<FolderBrowserProbeComponent> = {
  title: 'Components/FolderBrowser',
  component: FolderBrowserProbeComponent,
  decorators: [
    applicationConfig({ providers: storyProviders({ role: 'user' }) }),
    moduleMetadata({ imports: [FolderBrowserProbeComponent] }),
  ],
};
export default meta;

type Story = StoryObj<FolderBrowserProbeComponent>;

const audio = (name: string, size: number): BrowseFile => ({
  filename: name,
  size,
  bitRate: 320,
});

const DIRS: BrowseDir[] = [
  {
    name: '@@music\\Nocturnal Signal\\Static Bloom (2025) [FLAC]',
    fileCount: 3,
    files: [
      audio('01 - Opening Static.flac', 38_112_000),
      audio('02 - Half Light.flac', 41_820_000),
      audio('03 - Rain On Tin.flac', 36_004_000),
    ],
  },
  {
    name: '@@music\\Nocturnal Signal\\Half Light EP',
    fileCount: 2,
    files: [audio('01 - Half Light.mp3', 8_112_000), audio('02 - Tin Roof.mp3', 7_940_000)],
  },
  {
    name: '@@shared\\Compilations\\Various - Night Drive',
    fileCount: 1,
    files: [audio('07 - Opening Static.mp3', 8_004_000)],
  },
];

/** The matched folder is pre-selected, so the likely answer is one click away. */
export const FolderFirst: Story = {
  args: { dirs: DIRS, matchedPath: DIRS[0]!.name },
};

/** Browsing a peer takes seconds — slskd has to reach them first. */
export const Loading: Story = { args: { loading: true } };

/**
 * A peer that cannot be browsed at all. The per-track fallback still applies,
 * which is why this is an inline error rather than an empty panel.
 */
export const BrowseFailed: Story = {
  args: { errorMsg: 'Peer did not respond within 2.5 minutes' },
};

/**
 * No browse result, but the hunt already found individual files on this peer —
 * the per-track fallback that runs when zero folders match.
 */
export const FallbackFilesOnly: Story = {
  args: {
    fallbackFiles: [
      audio('Nocturnal Signal - Opening Static.mp3', 8_112_000),
      audio('Nocturnal Signal - Half Light.mp3', 7_940_000),
    ],
  },
};

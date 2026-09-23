import { NgComponentOutlet } from '@angular/common';
import {
  Component,
  DestroyRef,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
  type Type,
} from '@angular/core';
import type { HomeView } from '@nicotind/core';
import { lazy } from '../../lib/stale-chunk';
import { UserPreferencesService } from '../../services/user-preferences.service';
import { HomeViewSwitchComponent } from './home-view-switch.component';

/** One loader per view, each a lazy chunk. Injectable so a spec can count calls. */
export type HomeViewLoaders = Record<HomeView, () => Promise<Type<unknown>>>;

export const HOME_VIEW_LOADERS = new InjectionToken<HomeViewLoaders>('HOME_VIEW_LOADERS', {
  providedIn: 'root',
  factory: () => ({
    mosaic: lazy(() =>
      import('../mosaic-home/mosaic-home.component').then((m) => m.MosaicHomeComponent),
    ),
    shelves: lazy(() =>
      import('../radio-landing/radio-landing.component').then((m) => m.RadioLandingComponent),
    ),
  }),
});

/** The default stays the mosaic for everyone who never chose. */
export function homeViewOf(pref: HomeView | null | undefined): HomeView {
  return pref ?? 'mosaic';
}

/**
 * The home route (issue #1300): a thin shell that renders the view the user
 * chose and the switch to change it. Only the chosen view's chunk is ever
 * requested; the other page's data (its history, radio and stats calls) is
 * never asked for until the user switches, and switching swaps the component
 * in place — no navigation, same URL. The host is `contents` so the mosaic's
 * `absolute inset-0` stage keeps positioning against the layout's `<main>`
 * exactly as it did when it was the route component itself.
 */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [NgComponentOutlet, HomeViewSwitchComponent],
  templateUrl: './home.component.html',
  host: { class: 'contents' },
})
export class HomeComponent {
  private readonly prefs = inject(UserPreferencesService);
  private readonly loaders = inject(HOME_VIEW_LOADERS);
  private readonly destroyRef = inject(DestroyRef);

  readonly view = computed(() => homeViewOf(this.prefs.homeView()));
  readonly component = signal<Type<unknown> | null>(null);
  private loading: HomeView | null = null;
  private destroyed = false;

  constructor() {
    this.destroyRef.onDestroy(() => (this.destroyed = true));
    effect(() => {
      const view = this.view();
      void this.load(view);
    });
  }

  select(view: HomeView): void {
    this.prefs.patch({ homeView: view });
  }

  private async load(view: HomeView): Promise<void> {
    this.loading = view;
    const cls = await this.loaders[view]();
    // A later switch or a teardown wins over a chunk that arrived late.
    if (this.destroyed || this.loading !== view) return;
    this.component.set(cls);
  }
}

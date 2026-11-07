import { Component, input, output } from '@angular/core';
import { HOME_VIEWS, type HomeView } from '@nicotind/core';
import { IconComponent, type IconName } from '../../components/icon/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';

/** Each view's glyph. DI-free: the JIT harness can't drive app-icon's `name`. */
export function homeViewIcon(view: HomeView): IconName {
  return view === 'mosaic' ? 'layout-grid' : 'rows-3';
}

/**
 * Shelves | Mosaic — the home view switch (issue #1300). A radiogroup on the
 * Library-tab pattern (#1667): every option shows its icon, only the active
 * one its label. The home shell mounts it once, outside the view swap, and
 * decides what happens on a pick.
 */
@Component({
  selector: 'app-home-view-switch',
  standalone: true,
  imports: [IconComponent, TranslatePipe],
  templateUrl: './home-view-switch.component.html',
})
export class HomeViewSwitchComponent {
  // Not `input.required`: the JIT test harness cannot bind a nested
  // component's signal input (src/testing/signal-input.ts).
  readonly view = input<HomeView>('mosaic');
  readonly viewSelected = output<HomeView>();
  readonly options = HOME_VIEWS;

  labelKey(view: HomeView): string {
    return view === 'mosaic' ? 'home.viewMosaic' : 'home.viewShelves';
  }

  iconOf(view: HomeView): IconName {
    return homeViewIcon(view);
  }

  pick(view: HomeView): void {
    if (view !== this.view()) this.viewSelected.emit(view);
  }
}

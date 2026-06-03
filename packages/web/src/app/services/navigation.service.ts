import { Injectable, inject } from '@angular/core';
import { Location } from '@angular/common';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs';
import { shouldUseBrowserBack } from '../lib/nav-back';

/**
 * Tracks in-app navigation so a "back" button can return to the *previous view*
 * (e.g. album → back goes to the artist page you came from) instead of always
 * jumping to a hardcoded route. Falls back to a default route when the page was
 * opened via a deep-link with no in-app history to pop.
 */
@Injectable({ providedIn: 'root' })
export class NavigationService {
  private router = inject(Router);
  private location = inject(Location);
  private navigations = 0;

  constructor() {
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe(() => {
        this.navigations++;
      });
  }

  /** Go to the previous in-app view, or `fallback` if there is none. */
  back(fallback: unknown[]): void {
    if (shouldUseBrowserBack(this.navigations)) {
      this.location.back();
    } else {
      void this.router.navigate(fallback);
    }
  }
}

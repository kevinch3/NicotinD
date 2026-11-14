import { Component, inject, signal } from '@angular/core';
import { APP_BUILD_INFO, APP_VERSION } from '../../../app.config';
import { LICENCE_URL, REPO_URL } from '../../../lib/build-info';
import { ChangelogModalComponent } from '../../../components/changelog-modal/changelog-modal.component';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { PageBackService } from '../../../services/page-back.service';
import licences from '../../../../../public/licenses.json';

/** An SPDX link for a single id; an expression has no one page to link. */
export function spdxUrl(license: string): string | null {
  return /^[A-Za-z0-9.+-]+$/.test(license) ? `https://spdx.org/licenses/${license}.html` : null;
}

/**
 * Settings → About (issue #453): the licence notice and the AGPL §13 offer of
 * corresponding source, reachable from inside the running app rather than only
 * from the repository. → docs/licensing.md
 *
 * Third-party notices come from `licenses.json`, which
 * `scripts/generate-licenses.ts` writes at release. It is imported, not
 * fetched, so the list is the one this bundle was built with and reads offline.
 */
@Component({
  selector: 'app-about',
  imports: [
    ChangelogModalComponent,
    SettingsGroupComponent,
    TvNavGroupDirective,
    TvNavItemDirective,
    TranslatePipe,
  ],
  templateUrl: './about.component.html',
})
export class AboutComponent {
  constructor() {
    inject(PageBackService).registerRoute(['/settings']);
  }

  readonly version = inject(APP_VERSION);
  readonly build = inject(APP_BUILD_INFO);
  readonly repoUrl = REPO_URL;
  readonly licenceUrl = LICENCE_URL;

  /** Reuses the shared changelog modal rather than restating release notes. */
  readonly showChangelog = signal(false);

  readonly notices = licences.packages.map((p) => ({ ...p, licenseUrl: spdxUrl(p.license) }));
  readonly showNotices = signal(false);
}

import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ToastService } from './toast.service';
import { TranslateService } from './translate.service';
import type { ShareResourceType } from './share-session.service';

/** The browser's own share sheet, where one exists. Injectable so a test can stand in for it. */
export type NativeShare = (data: { title: string; url: string }) => Promise<void>;

export function nativeShare(nav: Navigator = navigator): NativeShare | null {
  // A fine pointer means a desktop, where the share sheet is a slower path to
  // the same clipboard: copy there, and keep the sheet for touch devices.
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return touch && typeof nav.share === 'function' ? (data) => nav.share(data) : null;
}

/**
 * Makes a share link (`POST /api/share`) and hands it over: the device's share
 * sheet on a touch device that has one, the clipboard otherwise (#2004).
 */
@Injectable({ providedIn: 'root' })
export class ShareLinkService {
  private readonly http = inject(HttpClient);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(TranslateService);

  async share(
    resourceType: ShareResourceType,
    resourceId: string,
    title: string,
    sheet: NativeShare | null = nativeShare(),
  ): Promise<void> {
    let url: string;
    try {
      ({ url } = await firstValueFrom(
        this.http.post<{ url: string }>('/api/share', { resourceType, resourceId }),
      ));
    } catch {
      this.toast.show({ kind: 'error', message: this.i18n.t('share.failed') });
      return;
    }
    if (sheet) {
      // Dismissing the sheet rejects; that is the user's answer, not an error.
      await sheet({ title, url }).catch(() => {});
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      this.toast.show({ kind: 'success', message: this.i18n.t('share.copied') });
    } catch {
      // No clipboard permission: show the link so it can be copied by hand.
      this.toast.show({ kind: 'info', message: url });
    }
  }
}

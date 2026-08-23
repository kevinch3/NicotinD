import { Component, OnDestroy, effect, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { MetricPillComponent } from '../../../components/metric-pill/metric-pill.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { AuthService } from '../../../services/auth.service';
import { ServerConfigService } from '../../../services/server-config.service';
import { SystemApiService } from '../../../services/api/system-api.service';
import { ServiceReviewService } from '../../../services/service-review.service';

/**
 * Admin card for host/service health: the CPU/memory/GPU metric pills, library
 * state, the server update check, and the live log stream.
 *
 * The metrics come off the shared `ServiceReview` snapshot; the log stream is
 * this panel's own `EventSource`, reconnected whenever the selected service
 * changes and closed on destroy.
 */
@Component({
  selector: 'app-system-health-panel',
  standalone: true,
  host: { class: 'contents' },
  imports: [
    SettingsGroupComponent,
    MetricPillComponent,
    TranslatePipe,
    TvNavGroupDirective,
    TvNavItemDirective,
  ],
  templateUrl: './system-health-panel.component.html',
})
export class SystemHealthPanelComponent implements OnDestroy {
  private readonly api = inject(SystemApiService);
  private readonly auth = inject(AuthService);
  private readonly server = inject(ServerConfigService);
  private readonly reviewSvc = inject(ServiceReviewService);

  readonly cpu = this.reviewSvc.cpu;
  readonly memory = this.reviewSvc.memory;
  readonly gpu = this.reviewSvc.gpu;
  readonly libraryState = this.reviewSvc.libraryState;
  readonly updateCheck = this.reviewSvc.updateCheck;

  readonly checkingUpdate = signal(false);
  readonly selectedService = signal<'nicotind'>('nicotind');
  readonly logLines = signal<string[]>([]);
  readonly logStreamStatus = signal<'idle' | 'connecting' | 'connected' | 'disconnected'>('idle');
  readonly logServiceOptions: 'nicotind'[] = ['nicotind'];

  private logEventSource: EventSource | null = null;
  private logReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Reconnect the stream whenever the selected service changes. */
  private readonly serviceSelectEffect = effect(() => {
    this.selectedService();
    this.connectLogStream();
  });

  ngOnDestroy(): void {
    this.disconnectLogStream();
  }

  selectLogService(svc: 'nicotind'): void {
    this.selectedService.set(svc);
    this.logLines.set([]);
  }

  public connectLogStream(): void {
    const token = this.auth.token();
    if (!token) return;
    this.disconnectLogStream();
    const service = this.selectedService();
    const src = new EventSource(this.server.sseUrl(`/api/system/logs/${service}/stream`, token));
    this.logEventSource = src;
    this.logStreamStatus.set('connecting');

    let everConnected = false;

    src.onopen = () => {
      everConnected = true;
      this.logStreamStatus.set('connected');
    };

    src.onmessage = (e) => {
      this.logLines.update((lines) => {
        const next = [...lines, e.data];
        return next.length > 500 ? next.slice(next.length - 500) : next;
      });
      this.scrollLogsToBottom();
    };

    src.onerror = () => {
      src.close();
      this.logEventSource = null;
      if (everConnected) {
        this.logStreamStatus.set('connecting');
        this.logReconnectTimer = setTimeout(() => this.connectLogStream(), 5000);
      } else {
        this.logStreamStatus.set('disconnected');
      }
    };
  }

  /** Manual "Check now" — forces a fresh GitHub poll (the data is then
   *  re-picked up by ServiceReview on the next 5s tick; we also refresh
   *  inline so the user sees the result without waiting). */
  async checkUpdateNow(): Promise<void> {
    if (this.checkingUpdate()) return;
    this.checkingUpdate.set(true);
    try {
      await firstValueFrom(this.api.getUpdateCheck(true));
      await this.reviewSvc.refresh();
    } catch {
      /* non-fatal */
    } finally {
      this.checkingUpdate.set(false);
    }
  }

  /** Local setter alias so the template's button click stays terse. */
  loadUpdateCheck(refresh = false): Promise<void> {
    return this.checkUpdateNow().then(() => undefined);
  }

  private disconnectLogStream(): void {
    if (this.logReconnectTimer !== null) {
      clearTimeout(this.logReconnectTimer);
      this.logReconnectTimer = null;
    }
    this.logEventSource?.close();
    this.logEventSource = null;
  }

  private scrollLogsToBottom(): void {
    setTimeout(() => {
      const el = document.querySelector('.log-scroll-container');
      if (el) (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
    }, 0);
  }
}

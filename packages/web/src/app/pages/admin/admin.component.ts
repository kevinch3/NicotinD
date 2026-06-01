import { Component, inject, signal, effect, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import {
  ApiService,
  type AdminUser,
  type AlbumJob,
  type UntrackedDownload,
  type DiscographyAlbum,
} from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PasswordFieldComponent } from '../../components/password-field/password-field.component';
import { AlbumHuntModalComponent } from '../../components/album-hunt-modal/album-hunt-modal.component';

@Component({
  selector: 'app-admin',
  imports: [FormsModule, PasswordFieldComponent, AlbumHuntModalComponent],
  templateUrl: './admin.component.html',
  })
export class AdminComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  readonly services: ('slskd' | 'navidrome')[] = ['slskd', 'navidrome'];

  readonly users = signal<AdminUser[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly resetTarget = signal<AdminUser | null>(null);
  readonly newPassword = signal('');
  readonly resetting = signal(false);

  readonly deleteTarget = signal<AdminUser | null>(null);
  readonly deleting = signal(false);

  readonly showCreateUser = signal(false);
  readonly newUsername = signal('');
  readonly newUserPassword = signal('');
  readonly creating = signal(false);

  readonly systemStatus = signal<{ slskd: { healthy: boolean; connected?: boolean }; navidrome: { healthy: boolean } } | null>(null);
  readonly scanStatus = signal<{ scanning: boolean; count: number } | null>(null);
  readonly restarting = signal<{ slskd: boolean; navidrome: boolean }>({ slskd: false, navidrome: false });

  // Incomplete album hunts (3A) — exhausted/active jobs with a re-hunt action.
  readonly incompleteJobs = signal<AlbumJob[]>([]);
  readonly jobsLoading = signal(true);
  // The job whose hunt the user is retrying (drives the embedded hunt modal).
  readonly retryAlbum = signal<DiscographyAlbum | null>(null);
  readonly retryArtist = signal('');

  // Untracked downloads (3E) — completed_downloads with no relative_path.
  readonly untracked = signal<UntrackedDownload[]>([]);
  readonly untrackedTotal = signal(0);
  readonly untrackedLoading = signal(true);

  readonly selectedService = signal<'slskd' | 'navidrome' | 'tailscale' | 'nicotind'>('nicotind');
  readonly logLines = signal<string[]>([]);
  readonly logStreamStatus = signal<'idle' | 'connecting' | 'connected' | 'disconnected'>('idle');

  private logEventSource: EventSource | null = null;
  private logReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly serviceSelectEffect = effect(() => {
    this.selectedService(); // track signal — reconnect stream on service change
    this.connectLogStream();
  });

  currentUserId(): string | null {
    const token = this.auth.token();
    if (!token) return null;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.sub as string;
    } catch { return null; }
  }

  ngOnInit(): void {
    this.loadUsers();
    this.loadSystemStatus();
    this.loadIncompleteJobs();
    this.loadUntracked();
  }

  async loadIncompleteJobs(): Promise<void> {
    this.jobsLoading.set(true);
    try {
      const { jobs } = await firstValueFrom(this.api.listAlbumJobs('incomplete'));
      this.incompleteJobs.set(jobs);
    } catch {
      this.incompleteJobs.set([]);
    } finally {
      this.jobsLoading.set(false);
    }
  }

  async loadUntracked(): Promise<void> {
    this.untrackedLoading.set(true);
    try {
      const { total, rows } = await firstValueFrom(this.api.getUntrackedDownloads(200));
      this.untracked.set(rows);
      this.untrackedTotal.set(total);
    } catch {
      this.untracked.set([]);
      this.untrackedTotal.set(0);
    } finally {
      this.untrackedLoading.set(false);
    }
  }

  // Open the album-hunt modal for a recorded job. Only jobs that still carry a
  // Lidarr album id can be re-hunted (the hunt flow keys off it).
  retryHunt(job: AlbumJob): void {
    if (job.lidarrAlbumId == null) return;
    this.retryArtist.set(job.artistName ?? '');
    this.retryAlbum.set({
      lidarrId: job.lidarrAlbumId,
      title: job.albumTitle ?? job.directory,
      foreignAlbumId: '',
      albumType: 'Album',
      secondaryTypes: [],
      totalTracks: 0,
      localTrackCount: 0,
      status: 'partial',
      tracks: [],
    });
  }

  onRetryClosed(): void {
    this.retryAlbum.set(null);
  }

  onRetryDownloaded(): void {
    this.retryAlbum.set(null);
    // The job will move back to 'active'; refresh shortly so the list reflects it.
    setTimeout(() => this.loadIncompleteJobs(), 1500);
  }

  jobStateClass(state: string): string {
    if (state === 'exhausted') return 'text-red-400';
    if (state === 'active') return 'text-amber-400';
    return 'text-zinc-400';
  }

  formatTimestamp(ms: number): string {
    return new Date(ms).toLocaleDateString();
  }

  ngOnDestroy(): void {
    this.disconnectLogStream();
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr + 'Z').toLocaleDateString();
  }

  getBadgeColor(svc: 'slskd' | 'navidrome'): string {
    const status = this.systemStatus();
    if (!status) return 'text-zinc-500';
    const health = status[svc];
    if (svc === 'slskd') {
      const connected = (health as { healthy: boolean; connected?: boolean }).connected;
      return connected ? 'text-emerald-400' : health.healthy ? 'text-amber-400' : 'text-red-400';
    }
    return health.healthy ? 'text-emerald-400' : 'text-red-400';
  }

  getDotColor(svc: 'slskd' | 'navidrome'): string {
    const status = this.systemStatus();
    if (!status) return 'bg-zinc-500';
    const health = status[svc];
    if (svc === 'slskd') {
      const connected = (health as { healthy: boolean; connected?: boolean }).connected;
      return connected ? 'bg-emerald-500' : health.healthy ? 'bg-amber-400' : 'bg-red-500';
    }
    return health.healthy ? 'bg-emerald-500' : 'bg-red-500';
  }

  getBadgeLabel(svc: 'slskd' | 'navidrome'): string {
    const status = this.systemStatus();
    if (!status) return '—';
    const health = status[svc];
    if (svc === 'slskd') {
      const connected = (health as { healthy: boolean; connected?: boolean }).connected;
      return connected ? 'Connected' : health.healthy ? 'Disconnected' : 'Unreachable';
    }
    return health.healthy ? 'Healthy' : 'Unreachable';
  }

  async toggleRole(user: AdminUser): Promise<void> {
    const newRole = user.role === 'admin' ? 'user' : 'admin';
    try {
      await firstValueFrom(this.api.updateUserRole(user.id, newRole as 'admin' | 'user'));
      this.users.update(prev => prev.map(u => u.id === user.id ? { ...u, role: newRole } : u));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to update role');
    }
  }

  async toggleStatus(user: AdminUser): Promise<void> {
    const newStatus = user.status === 'active' ? 'disabled' : 'active';
    try {
      await firstValueFrom(this.api.updateUserStatus(user.id, newStatus as 'active' | 'disabled'));
      this.users.update(prev => prev.map(u => u.id === user.id ? { ...u, status: newStatus } : u));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to update status');
    }
  }

  async handleResetPassword(): Promise<void> {
    const target = this.resetTarget();
    if (!target || !this.newPassword().trim()) return;
    this.resetting.set(true);
    try {
      await firstValueFrom(this.api.resetUserPassword(target.id, this.newPassword().trim()));
      this.resetTarget.set(null);
      this.newPassword.set('');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      this.resetting.set(false);
    }
  }

  async handleCreateUser(): Promise<void> {
    const username = this.newUsername().trim();
    const password = this.newUserPassword().trim();
    if (!username || !password) return;
    this.creating.set(true);
    try {
      const user = await firstValueFrom(this.api.createUser(username, password));
      this.users.update(prev => [...prev, user]);
      this.showCreateUser.set(false);
      this.newUsername.set('');
      this.newUserPassword.set('');
    } catch (err: any) {
      this.error.set(err.error?.error ?? err.message ?? 'Failed to create user');
    } finally {
      this.creating.set(false);
    }
  }

  async handleDeleteUser(): Promise<void> {
    const target = this.deleteTarget();
    if (!target) return;
    this.deleting.set(true);
    try {
      await firstValueFrom(this.api.deleteUser(target.id));
      this.users.update(prev => prev.filter(u => u.id !== target.id));
      this.deleteTarget.set(null);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to delete user');
    } finally {
      this.deleting.set(false);
    }
  }

  async handleRestart(service: 'slskd' | 'navidrome'): Promise<void> {
    this.restarting.update(prev => ({ ...prev, [service]: true }));
    try {
      await firstValueFrom(this.api.restartService(service));
      setTimeout(() => this.loadSystemStatus(), 3000);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : `Failed to restart ${service}`);
    } finally {
      this.restarting.update(prev => ({ ...prev, [service]: false }));
    }
  }

  readonly logServiceOptions: ('slskd' | 'navidrome' | 'tailscale' | 'nicotind')[] = ['slskd', 'navidrome', 'tailscale', 'nicotind'];

  selectLogService(svc: 'slskd' | 'navidrome' | 'tailscale' | 'nicotind'): void {
    this.selectedService.set(svc);
    this.logLines.set([]);
  }

  public connectLogStream(): void {
    const token = this.auth.token();
    if (!token) return;
    this.disconnectLogStream();
    const service = this.selectedService();
    const src = new EventSource(`/api/system/logs/${service}/stream?token=${encodeURIComponent(token ?? '')}`);
    this.logEventSource = src;
    this.logStreamStatus.set('connecting');

    let everConnected = false;

    src.onopen = () => {
      everConnected = true;
      this.logStreamStatus.set('connected');
    };

    src.onmessage = (e) => {
      this.logLines.update(lines => {
        const next = [...lines, e.data];
        return next.length > 500 ? next.slice(next.length - 500) : next;
      });
      this.scrollLogsToBottom();
    };

    src.onerror = () => {
      src.close();
      this.logEventSource = null;
      if (everConnected) {
        // Transient disconnect — reconnect
        this.logStreamStatus.set('connecting');
        this.logReconnectTimer = setTimeout(() => this.connectLogStream(), 5000);
      } else {
        // Never established (e.g. 503) — don't retry
        this.logStreamStatus.set('disconnected');
      }
    };
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
    // Use setTimeout to allow Angular to render new lines first
    setTimeout(() => {
      const el = document.querySelector('.log-scroll-container');
      if (el) el.scrollTop = el.scrollHeight;
    }, 0);
  }

  private async loadUsers(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const data = await firstValueFrom(this.api.getUsers());
      this.users.set(data);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      this.loading.set(false);
    }
  }

  private async loadSystemStatus(): Promise<void> {
    try {
      const [status, scan] = await Promise.all([
        firstValueFrom(this.api.getStatus()),
        firstValueFrom(this.api.getScanStatus()),
      ]);
      this.systemStatus.set(status as any);
      this.scanStatus.set(scan);
    } catch { /* non-fatal */ }
  }
}

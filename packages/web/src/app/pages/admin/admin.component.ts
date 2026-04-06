import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService, type AdminUser } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { PasswordFieldComponent } from '../../components/password-field/password-field.component';

@Component({
  selector: 'app-admin',
  imports: [FormsModule, PasswordFieldComponent],
  templateUrl: './admin.component.html',
  })
export class AdminComponent implements OnInit {
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
  readonly logService = signal<'slskd' | 'navidrome'>('slskd');
  readonly logs = signal<string[]>([]);
  readonly logHint = signal<string | null>(null);
  readonly logsLoading = signal(false);
  readonly logsLoaded = signal(false);

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
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr + 'Z').toLocaleDateString();
  }

  getBadgeColor(svc: 'slskd' | 'navidrome'): string {
    const status = this.systemStatus();
    if (!status) return 'text-zinc-500';
    const health = status[svc];
    if (svc === 'slskd') {
      const connected = (health as any)?.connected;
      return connected ? 'text-emerald-400' : health.healthy ? 'text-amber-400' : 'text-red-400';
    }
    return health.healthy ? 'text-emerald-400' : 'text-red-400';
  }

  getDotColor(svc: 'slskd' | 'navidrome'): string {
    const status = this.systemStatus();
    if (!status) return 'bg-zinc-500';
    const health = status[svc];
    if (svc === 'slskd') {
      const connected = (health as any)?.connected;
      return connected ? 'bg-emerald-500' : health.healthy ? 'bg-amber-400' : 'bg-red-500';
    }
    return health.healthy ? 'bg-emerald-500' : 'bg-red-500';
  }

  getBadgeLabel(svc: 'slskd' | 'navidrome'): string {
    const status = this.systemStatus();
    if (!status) return '—';
    const health = status[svc];
    if (svc === 'slskd') {
      const connected = (health as any)?.connected;
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

  async loadLogs(service: 'slskd' | 'navidrome'): Promise<void> {
    this.logService.set(service);
    this.logsLoading.set(true);
    this.logHint.set(null);
    try {
      const res = await firstValueFrom(this.api.getServiceLogs(service));
      this.logs.set(res.logs);
      this.logHint.set(res.hint ?? null);
    } catch {
      this.logs.set([`Failed to load ${service} logs`]);
    } finally {
      this.logsLoading.set(false);
      this.logsLoaded.set(true);
    }
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

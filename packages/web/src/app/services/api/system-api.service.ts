import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { ProcessingSettings, ProcessingStatus } from '@nicotind/core';
import type { StreamingSettings, SetupStatus, SetupResult, SetupBody, AdminUser } from './api-types';

/** System surface: status/scan/logs, settings (soulseek/shares/streaming/
 *  processing), first-run setup, and admin user management. */
@Injectable({ providedIn: 'root' })
export class SystemApiService {
  private http = inject(HttpClient);

  // System
  getStatus() {
    return this.http.get<{ slskd: { healthy: boolean } }>('/api/system/status');
  }

  triggerScan() {
    return this.http.post<{ ok: boolean }>('/api/system/scan', {});
  }

  getScanStatus() {
    return this.http.get<{ scanning: boolean; count: number }>('/api/system/scan/status');
  }

  restartService(service: 'slskd') {
    return this.http.post<{ ok: boolean }>(`/api/system/restart/${service}`, {});
  }

  getServiceLogs(service: string, lines = 100) {
    return this.http.get<{ logs: string[]; hint?: string }>(`/api/system/logs/${service}`, {
      params: { lines },
    });
  }

  // Settings
  getSoulseekSettings() {
    return this.http.get<{
      username: string;
      configured: boolean;
      connected: boolean;
      listeningPort?: number;
      enableUPnP?: boolean;
    }>('/api/settings/soulseek');
  }

  saveSoulseekSettings(
    username: string,
    password?: string,
    network?: { listeningPort: number; enableUPnP: boolean },
  ) {
    return this.http.put<{ ok: boolean; message: string; connected?: boolean; username?: string }>(
      '/api/settings/soulseek',
      { username, password, ...network },
    );
  }

  getSoulseekStatus() {
    return this.http.get<{ configured: boolean; connected: boolean; username: string | null }>(
      '/api/settings/soulseek/status',
    );
  }

  toggleSoulseekConnection() {
    return this.http.post<{ connected: boolean }>('/api/settings/soulseek/toggle', {});
  }

  getShares() {
    return this.http.get<{ directories: string[] }>('/api/settings/shares');
  }

  addShare(path: string) {
    return this.http.post<{ ok: boolean }>('/api/settings/shares', { path });
  }

  removeShare(path: string) {
    return this.http.delete<{ ok: boolean }>(`/api/settings/shares/${encodeURIComponent(path)}`);
  }

  rescanShares() {
    return this.http.post<{ ok: boolean }>('/api/settings/shares/rescan', {});
  }

  // Streaming / transcoding
  getStreamingSettings() {
    return this.http.get<StreamingSettings>('/api/settings/streaming');
  }

  saveStreamingSettings(patch: Partial<StreamingSettings>) {
    return this.http.put<StreamingSettings>('/api/settings/streaming', patch);
  }

  // Windowed library processing (BPM / genre enrichment) — admin only.
  getProcessing() {
    return this.http.get<{ settings: ProcessingSettings; status: ProcessingStatus }>(
      '/api/admin/processing',
    );
  }

  saveProcessing(patch: Partial<ProcessingSettings>) {
    return this.http.put<{ settings: ProcessingSettings; status: ProcessingStatus }>(
      '/api/admin/processing',
      patch,
    );
  }

  runProcessing() {
    return this.http.post<{ ok: boolean }>('/api/admin/processing/run', {});
  }

  stopProcessing() {
    return this.http.post<{ ok: boolean }>('/api/admin/processing/stop', {});
  }

  // Setup (public — no auth token)
  getSetupStatus() {
    return this.http.get<SetupStatus>('/api/setup/status');
  }

  completeSetup(data: SetupBody) {
    return this.http.post<SetupResult>('/api/setup/complete', data);
  }

  // Admin
  getUsers() {
    return this.http.get<AdminUser[]>('/api/admin/users');
  }

  createUser(username: string, password: string) {
    return this.http.post<AdminUser>('/api/admin/users', { username, password });
  }

  updateUserRole(id: string, role: 'admin' | 'user') {
    return this.http.put<{ ok: boolean }>(`/api/admin/users/${id}/role`, { role });
  }

  updateUserStatus(id: string, status: 'active' | 'disabled') {
    return this.http.put<{ ok: boolean }>(`/api/admin/users/${id}/status`, { status });
  }

  resetUserPassword(id: string, password: string) {
    return this.http.put<{ ok: boolean }>(`/api/admin/users/${id}/password`, { password });
  }

  deleteUser(id: string) {
    return this.http.delete<{ ok: boolean }>(`/api/admin/users/${id}`);
  }
}

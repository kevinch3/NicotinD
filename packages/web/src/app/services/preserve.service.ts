import { Injectable, inject, signal } from '@angular/core';
import * as db from '../lib/preserve-store';
import { DEFAULT_BUDGET, type PreservedTrackMeta } from '../lib/preserve-store';
import type { Track } from './player.service';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class PreserveService {
  private auth = inject(AuthService);

  readonly preservedIds = signal(new Set<string>());
  readonly totalUsage = signal(0);
  readonly budget = signal(DEFAULT_BUDGET);
  readonly preserving = signal(new Set<string>());
  readonly preservedTracks = signal<PreservedTrackMeta[]>([]);

  async init(): Promise<void> {
    const all = await db.getAll();
    const ids = new Set(all.map(t => t.id));
    const usage = all.reduce((sum, t) => sum + t.size, 0);
    this.preservedIds.set(ids);
    this.totalUsage.set(usage);
    this.preservedTracks.set(all);
  }

  async preserve(track: Track): Promise<void> {
    const token = this.auth.token();
    if (!token || this.preserving().has(track.id) || this.preservedIds().has(track.id)) return;

    this.preserving.update(s => new Set(s).add(track.id));

    try {
      const audioRes = await fetch(`/api/stream/${track.id}?token=${token}`);
      if (!audioRes.ok) throw new Error(`Failed to fetch audio: ${audioRes.status}`);

      const audioBlob = await audioRes.blob();
      let coverBlob: Blob | null = null;

      if (track.coverArt) {
        try {
          const coverRes = await fetch(`/api/cover/${track.coverArt}?size=600&token=${token}`);
          if (coverRes.ok) coverBlob = await coverRes.blob();
        } catch { /* ignore cover failures */ }
      }

      await db.evictLRU(audioBlob.size, this.budget());

      const now = Date.now();
      const meta: PreservedTrackMeta = {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album ?? '',
        coverArt: track.coverArt,
        duration: track.duration,
        size: audioBlob.size,
        format: audioRes.headers.get('content-type') ?? 'audio/mpeg',
        preservedAt: now,
        lastAccessedAt: now,
      };

      await db.preserve(meta, audioBlob, coverBlob);

      this.preservedIds.update(s => new Set(s).add(track.id));
      this.preserving.update(s => { const n = new Set(s); n.delete(track.id); return n; });
      await this.refreshList();
    } catch {
      this.preserving.update(s => { const n = new Set(s); n.delete(track.id); return n; });
    }
  }

  async remove(id: string): Promise<void> {
    await db.remove(id);
    this.preservedIds.update(s => { const n = new Set(s); n.delete(id); return n; });
    await this.refreshList();
  }

  isPreserved(id: string): boolean {
    return this.preservedIds().has(id);
  }

  isPreserving(id: string): boolean {
    return this.preserving().has(id);
  }

  async downloadToDevice(id: string, filename: string): Promise<void> {
    const blob = await db.getBlob(id);
    if (!blob) return;

    const url = URL.createObjectURL(blob.audio);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async refreshList(): Promise<void> {
    const all = await db.getAll();
    const ids = new Set(all.map(t => t.id));
    const usage = all.reduce((sum, t) => sum + t.size, 0);
    this.preservedIds.set(ids);
    this.totalUsage.set(usage);
    this.preservedTracks.set(all);
  }
}

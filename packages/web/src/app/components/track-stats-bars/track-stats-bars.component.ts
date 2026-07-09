import { Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface TrackMetric {
  label: string;
  value: number;
  color: string;
}

export interface TrackBadge {
  label: string;
  value: string;
  icon: string;
}

@Component({
  selector: 'app-track-stats-bars',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './track-stats-bars.component.html',
  styleUrls: ['./track-stats-bars.component.css'],
})
export class TrackStatsBarsComponent {
  readonly bpm = input<number | null>(null);
  readonly genre = input<string | null>(null);
  readonly key = input<string | null>(null);
  readonly mood = input<string | null>(null);
  readonly energy = input<number | null>(null);
  readonly valence = input<number | null>(null);
  readonly danceability = input<number | null>(null);
  readonly acousticness = input<number | null>(null);
  readonly instrumental = input<number | null>(null);

  readonly badges = computed<TrackBadge[]>(() => {
    const list: TrackBadge[] = [];
    const bpmVal = this.bpm();
    if (bpmVal != null) list.push({ label: 'BPM', value: String(Math.round(bpmVal)), icon: '🥁' });
    const genreVal = this.genre();
    if (genreVal) list.push({ label: 'Genre', value: genreVal, icon: '🎵' });
    const keyVal = this.key();
    if (keyVal) list.push({ label: 'Key', value: keyVal, icon: '🎹' });
    const moodVal = this.mood();
    if (moodVal) list.push({ label: 'Mood', value: moodVal.charAt(0).toUpperCase() + moodVal.slice(1), icon: '✨' });
    return list;
  });

  readonly metrics = computed<TrackMetric[]>(() => {
    const items: { label: string; raw: number | undefined | null; color: string }[] = [
      { label: 'Energy', raw: this.energy(), color: 'var(--bar-color-energy, #f97316)' },
      { label: 'Valence', raw: this.valence(), color: 'var(--bar-color-valence, #22c55e)' },
      { label: 'Dance', raw: this.danceability(), color: 'var(--bar-color-dance, #a78bfa)' },
      { label: 'Acoustic', raw: this.acousticness(), color: 'var(--bar-color-acoustic, #38bdf8)' },
      { label: 'Instrumental', raw: this.instrumental(), color: 'var(--bar-color-instrumental, #e879f9)' },
    ];
    return items
      .filter((i) => typeof i.raw === 'number')
      .map((i) => ({
        label: i.label,
        value: Math.round(i.raw! * 100),
        color: i.color,
      }));
  });
}

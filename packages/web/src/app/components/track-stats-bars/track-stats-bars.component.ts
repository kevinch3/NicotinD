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
  styles: `
    :host {
      display: block;
    }

    .badge-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 14px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 10px;
      border-radius: 6px;
      background: var(--theme-surface-2);
      font-size: 12px;
      font-weight: 600;
      color: var(--theme-primary);
      line-height: 1;
      white-space: nowrap;
    }

    .badge-icon {
      font-size: 13px;
      opacity: 0.7;
    }

    .badge-value {
      color: var(--theme-secondary);
      font-weight: 500;
    }

    .bar-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .bar-item {
      display: grid;
      grid-template-columns: 72px 1fr 36px;
      align-items: center;
      gap: 8px;
    }

    .bar-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--theme-muted);
      text-align: right;
    }

    .bar-track {
      position: relative;
      height: 10px;
      border-radius: 5px;
      background: var(--theme-surface-2);
      overflow: hidden;
    }

    .bar-fill {
      position: absolute;
      inset: 0;
      border-radius: 5px;
      width: var(--bar-current, 0%);
      transition: width 0.6s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .bar-fill::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 5px;
      background: linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.25) 0%,
        transparent 60%
      );
    }

    .bar-value {
      font-size: 11px;
      font-weight: 700;
      color: var(--theme-secondary);
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
  `,
  template: `
    <!-- Badges: BPM, Genre, Key, Mood -->
    @if (badges().length) {
      <div class="badge-row">
        @for (b of badges(); track b.label) {
          <span class="badge" [attr.data-testid]="'badge-' + b.label.toLowerCase()">
            <span class="badge-icon">{{ b.icon }}</span>
            <span class="badge-value">{{ b.value }}</span>
          </span>
        }
      </div>
    }

    <!-- Bars: Energy, Valence, Dance, Acoustic, Instrumental -->
    @if (metrics().length) {
      <div class="bar-list">
        @for (m of metrics(); track m.label) {
          <div class="bar-item" [attr.data-testid]="'bar-' + m.label.toLowerCase()">
            <span class="bar-label">{{ m.label }}</span>
            <div class="bar-track">
              <div
                class="bar-fill"
                [style.--bar-current.%]="m.value"
                [style.background]="m.color"
              ></div>
            </div>
            <span class="bar-value">{{ m.value }}%</span>
          </div>
        }
      </div>
    }
  `,
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

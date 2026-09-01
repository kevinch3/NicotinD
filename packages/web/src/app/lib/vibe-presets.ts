import type { LibraryFilter } from '@nicotind/core';

/** A one-tap "vibe": a friendly label + emoji over a canonical LibraryFilter. */
export interface VibePreset {
  id: string;
  label: string;
  emoji: string;
  /** Tailwind `from-*`/`to-*` pair painted behind white text. */
  gradient: string;
  filter: LibraryFilter;
}

// Simplified, human-named starters mapped onto the shared filter vocabulary
// (moods, perceptual buckets, bpm). Each starts filter-seeded radio instantly.
// `label` is an i18n key (issue #236), rendered through the `t` pipe.
//
// Shared by the mosaic home and the classic landing, so the two cannot drift.
// Kept in a `.ts` module deliberately: Tailwind's `@source "./**/*.ts"` scan is
// what generates these gradient classes, and they appear nowhere else.
//
// Each `gradient` is a fixed Tailwind pair painted behind bold white text.
// Two rules shaped the choices:
//
//  - **The `to-` stop carries the label.** The classic tile is `justify-end`, so
//    the text sits at the bottom-right — over the gradient's *end* colour. Every
//    `to-` stop is therefore a 700, which clears 4.5:1 against white; the `from-`
//    stop is free to be light because no text sits on it. A flat 400/500 fill
//    would have put 2–3:1 under the label.
//  - **Neighbours must differ, not just look nice.** The classic row is
//    `grid-flow-col grid-rows-2`, so the array order fills COLUMNS: (happy,
//    chill) (party, energetic) (danceable, uplifting) (fast, acoustic). Each
//    pair above is a vertical neighbour and was picked to contrast with the one
//    beside it, which is why the two hot vibes (energetic, fast) sit in
//    different rows and columns rather than next to each other. The mosaic
//    packs by score rather than by array order, so this rule constrains only
//    the classic landing — but changing the order there still needs it.
export const VIBE_PRESETS: readonly VibePreset[] = [
  {
    id: 'happy',
    label: 'vibe.happy',
    emoji: '😊',
    gradient: 'from-amber-400 to-orange-700',
    filter: { moods: ['happy'] },
  },
  {
    id: 'chill',
    label: 'vibe.chill',
    emoji: '😌',
    gradient: 'from-sky-400 to-cyan-700',
    filter: { moods: ['relaxed'] },
  },
  {
    id: 'party',
    label: 'vibe.party',
    emoji: '🎉',
    gradient: 'from-fuchsia-500 to-purple-700',
    filter: { moods: ['party'] },
  },
  {
    id: 'energetic',
    label: 'vibe.energetic',
    emoji: '⚡',
    gradient: 'from-red-500 to-rose-700',
    filter: { buckets: { energy: ['high'] } },
  },
  {
    id: 'danceable',
    label: 'vibe.danceable',
    emoji: '💃',
    gradient: 'from-violet-500 to-indigo-700',
    filter: { buckets: { danceability: ['high'] } },
  },
  {
    id: 'uplifting',
    label: 'vibe.uplifting',
    emoji: '☀️',
    gradient: 'from-yellow-400 to-amber-700',
    filter: { buckets: { valence: ['high'] } },
  },
  {
    id: 'fast',
    label: 'vibe.fast',
    emoji: '🏃',
    gradient: 'from-orange-500 to-red-700',
    filter: { bpmMin: 120 },
  },
  {
    id: 'acoustic',
    label: 'vibe.acoustic',
    emoji: '🎸',
    gradient: 'from-emerald-500 to-teal-700',
    filter: { buckets: { acousticness: ['high'] } },
  },
];

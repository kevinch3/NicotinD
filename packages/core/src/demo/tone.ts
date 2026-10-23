/**
 * Deterministic tone "songs" for the demo catalog (docs/demo-mode.md).
 *
 * why: the demo and the product tour need audio that is free to redistribute,
 * costs no bytes to ship, and sounds like music rather than a test signal. A
 * song is therefore a pure function of its seed: tempo, key, chords and melody
 * are drawn from a seeded PRNG and synthesised here, so the build script (Bun,
 * encoding FLAC for a real server) and the static demo (the browser, rendering
 * on play) produce the same song from the same id.
 *
 * The metadata is honest about the audio: `bpm` is the tempo actually rendered
 * and `durationSec` is the exact rendered length — the player rejects a
 * duration far from the API's (`browserDurationIsAcceptable`), so it must match.
 */
import { pick, randInt, seededRandom } from './random.js';

export type DemoGenre =
  'Indie Pop' | 'Dream Pop' | 'Folk' | 'Synthwave' | 'Jazz' | 'Funk' | 'Ambient';

type Drums = 'none' | 'soft' | 'full';
type Wave = 'sine' | 'triangle' | 'soft-square' | 'pluck';

interface GenreProfile {
  bpm: [number, number];
  mode: 'major' | 'minor';
  drums: Drums;
  lead: Wave;
  /** Chance a beat carries a melody note; lower reads as calmer. */
  density: number;
}

const GENRES: Record<DemoGenre, GenreProfile> = {
  'Indie Pop': { bpm: [104, 124], mode: 'major', drums: 'full', lead: 'triangle', density: 0.75 },
  'Dream Pop': { bpm: [76, 92], mode: 'major', drums: 'soft', lead: 'sine', density: 0.55 },
  Folk: { bpm: [84, 100], mode: 'major', drums: 'none', lead: 'pluck', density: 0.7 },
  Synthwave: { bpm: [96, 112], mode: 'minor', drums: 'full', lead: 'soft-square', density: 0.7 },
  Jazz: { bpm: [88, 116], mode: 'minor', drums: 'soft', lead: 'triangle', density: 0.6 },
  Funk: { bpm: [100, 116], mode: 'minor', drums: 'full', lead: 'pluck', density: 0.8 },
  Ambient: { bpm: [60, 72], mode: 'major', drums: 'none', lead: 'sine', density: 0.35 },
};

const DIATONIC = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] } as const;
const PENTATONIC = { major: [0, 2, 4, 7, 9], minor: [0, 3, 5, 7, 10] } as const;
/** Chord progressions as diatonic degree indices (I–V–vi–IV and friends). */
const PROGRESSIONS: Record<'major' | 'minor', readonly (readonly number[])[]> = {
  major: [
    [0, 4, 5, 3],
    [0, 5, 3, 4],
    [5, 3, 0, 4],
    [0, 3, 0, 4],
  ],
  minor: [
    [0, 5, 2, 6],
    [0, 3, 4, 0],
    [0, 6, 5, 6],
    [0, 5, 3, 4],
  ],
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const INTRO_BARS = 2;
const OUTRO_BARS = 2;

export interface ToneSpec {
  seed: string;
  genre: DemoGenre;
  bpm: number;
  /** MIDI note of the key's tonic, in the chord octave (C3–A3). */
  rootMidi: number;
  mode: 'major' | 'minor';
  /** Musical key, e.g. "A minor" — what an audio-analysis pass would report. */
  key: string;
  bars: number;
  durationSec: number;
  progression: readonly number[];
}

/** What a song will sound like, without rendering it. Cheap; call freely. */
export function toneSpec(seed: string, genre: DemoGenre): ToneSpec {
  const rand = seededRandom(`spec:${seed}`);
  const profile = GENRES[genre];
  const bpm = randInt(rand, profile.bpm[0], profile.bpm[1]);
  const rootMidi = randInt(rand, 48, 57);
  const targetSec = randInt(rand, 45, 90);
  const secPerBar = (4 * 60) / bpm;
  const bars = Math.max(INTRO_BARS + OUTRO_BARS + 8, Math.round(targetSec / secPerBar));
  return {
    seed,
    genre,
    bpm,
    rootMidi,
    mode: profile.mode,
    key: `${NOTE_NAMES[rootMidi % 12]} ${profile.mode}`,
    bars,
    durationSec: bars * secPerBar,
    progression: pick(rand, PROGRESSIONS[profile.mode]),
  };
}

const midiHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/**
 * Render a spec to mono float samples in [-1, 1], exactly
 * `round(durationSec * sampleRate)` long.
 *
 * Notes are mixed additively into one buffer — far cheaper than evaluating every
 * voice per sample — then normalised and faded at both ends.
 */
export function renderTone(spec: ToneSpec, sampleRate = 22050): Float32Array {
  const out = new Float32Array(Math.round(spec.durationSec * sampleRate));
  const rand = seededRandom(`render:${spec.seed}`);
  const profile = GENRES[spec.genre];
  const beatSec = 60 / spec.bpm;
  const diatonic = DIATONIC[spec.mode];
  const penta = PENTATONIC[spec.mode];

  const note = (startSec: number, lenSec: number, hz: number, amp: number, wave: Wave) =>
    addNote(out, sampleRate, startSec, lenSec, hz, amp, wave);

  // Melody walks a two-octave pentatonic ladder so steps stay small and nothing
  // clashes with the chords underneath.
  const ladder: number[] = [];
  for (let oct = 0; oct < 2; oct++) for (const step of penta) ladder.push(12 + oct * 12 + step);
  let rung = randInt(rand, 2, ladder.length - 3);

  for (let bar = 0; bar < spec.bars; bar++) {
    const barStart = bar * 4 * beatSec;
    const degree = spec.progression[bar % spec.progression.length]!;
    const triad = [0, 2, 4].map((offset) => {
      const idx = degree + offset;
      return spec.rootMidi + diatonic[idx % 7]! + 12 * Math.floor(idx / 7);
    });
    const body = bar >= INTRO_BARS && bar < spec.bars - OUTRO_BARS;

    // Pad: the chord, held for the whole bar.
    for (const midi of triad) note(barStart, 4 * beatSec, midiHz(midi), 0.07, 'sine');
    if (!body) continue;

    // Bass on beats 1 and 3.
    for (const beat of [0, 2]) {
      note(barStart + beat * beatSec, 1.8 * beatSec, midiHz(triad[0]! - 12), 0.2, 'triangle');
    }

    for (let beat = 0; beat < 4; beat++) {
      const t = barStart + beat * beatSec;
      if (profile.drums !== 'none') {
        if (profile.drums === 'full' && (beat === 0 || beat === 2)) kick(out, sampleRate, t);
        if (profile.drums === 'full' && (beat === 1 || beat === 3)) {
          noiseHit(out, sampleRate, t, 0.12, 0.09, rand);
        }
        noiseHit(out, sampleRate, t + beatSec / 2, 0.035, 0.03, rand);
      }
      if (rand() > profile.density) continue;
      rung = Math.min(ladder.length - 1, Math.max(0, rung + randInt(rand, -2, 2)));
      const eighths = profile.density > 0.6 && rand() < 0.3;
      const len = eighths ? beatSec / 2 : beatSec;
      note(t, len * 1.6, midiHz(spec.rootMidi + ladder[rung]!), 0.12, profile.lead);
      if (eighths) {
        rung = Math.min(ladder.length - 1, Math.max(0, rung + randInt(rand, -1, 1)));
        note(t + len, len * 1.6, midiHz(spec.rootMidi + ladder[rung]!), 0.1, profile.lead);
      }
    }
  }

  let peak = 0;
  for (const s of out) peak = Math.max(peak, Math.abs(s));
  const gain = peak > 0 ? 0.7 / peak : 0;
  const fadeIn = Math.round(1 * sampleRate);
  const fadeOut = Math.round(2.5 * sampleRate);
  for (let i = 0; i < out.length; i++) {
    let g = gain;
    if (i < fadeIn) g *= i / fadeIn;
    const fromEnd = out.length - 1 - i;
    if (fromEnd < fadeOut) g *= fromEnd / fadeOut;
    out[i]! *= g;
  }
  return out;
}

function addNote(
  out: Float32Array,
  sampleRate: number,
  startSec: number,
  lenSec: number,
  hz: number,
  amp: number,
  wave: Wave,
): void {
  const start = Math.round(startSec * sampleRate);
  const len = Math.round(lenSec * sampleRate);
  const attack = wave === 'sine' ? 0.04 : 0.008;
  const release = Math.min(0.25, lenSec / 3);
  const w = (2 * Math.PI * hz) / sampleRate;
  for (let i = 0; i < len && start + i < out.length; i++) {
    const t = i / sampleRate;
    let env = Math.min(1, t / attack) * Math.min(1, (lenSec - t) / release);
    if (wave === 'pluck' || wave === 'triangle') env *= Math.exp(-t * 3);
    const p = w * i;
    let v: number;
    switch (wave) {
      case 'soft-square':
        v = Math.sin(p) + Math.sin(3 * p) / 3 + Math.sin(5 * p) / 5;
        break;
      case 'triangle':
        v = Math.sin(p) - Math.sin(3 * p) / 9 + Math.sin(5 * p) / 25;
        break;
      case 'pluck':
        v = Math.sin(p) + 0.5 * Math.sin(2 * p) * Math.exp(-t * 8);
        break;
      default:
        v = Math.sin(p);
    }
    out[start + i]! += amp * env * v;
  }
}

/** A sine whose pitch falls 110 → 45 Hz: reads as a soft kick drum. */
function kick(out: Float32Array, sampleRate: number, startSec: number): void {
  const start = Math.round(startSec * sampleRate);
  const len = Math.round(0.25 * sampleRate);
  let phase = 0;
  for (let i = 0; i < len && start + i < out.length; i++) {
    const t = i / sampleRate;
    const hz = 45 + 65 * Math.exp(-t * 30);
    phase += (2 * Math.PI * hz) / sampleRate;
    out[start + i]! += 0.32 * Math.exp(-t * 14) * Math.sin(phase);
  }
}

/** A seeded noise burst: a hi-hat at short decay, a snare at longer. */
function noiseHit(
  out: Float32Array,
  sampleRate: number,
  startSec: number,
  amp: number,
  decaySec: number,
  rand: () => number,
): void {
  const start = Math.round(startSec * sampleRate);
  const len = Math.round(decaySec * 4 * sampleRate);
  for (let i = 0; i < len && start + i < out.length; i++) {
    out[start + i]! += amp * Math.exp(-i / sampleRate / decaySec) * (rand() * 2 - 1);
  }
}

/** Float samples → signed 16-bit PCM, the input both ffmpeg and a WAV header want. */
export function toPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767);
  }
  return pcm;
}

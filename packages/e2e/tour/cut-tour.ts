/**
 * Assembles the recorded tour into the README video and its GIF teaser.
 *
 * Reads the cut list each shot wrote (`tour-output/shots/NN.json`): trims every
 * segment, speeds up the `fast()` ones, fades each shot in and out, and joins
 * them in order. Re-encodes once, to H.264 MP4 (what GitHub plays inline) and a
 * palette-optimised GIF of the acquire shot (what a README shows without a click).
 *
 *   bun run tour/cut-tour.ts      →  tour-output/nicotind-tour.mp4, nicotind-tour.gif
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SHOTS_DIR, type ShotRecord } from './shot.js';

const OUT_DIR = resolve(SHOTS_DIR, '..');
const MP4 = join(OUT_DIR, 'nicotind-tour.mp4');
const GIF = join(OUT_DIR, 'nicotind-tour.gif');
const FADE = 0.3;
const FPS = 30;
/** The shot the GIF teaser is cut from — the one thing the product does that others do not. */
const GIF_SHOT = 'acquire';
const GIF_SPEED = 1.6;

function findVideo(dir: string): string {
  const webm = readdirSync(dir).find((f) => f.endsWith('.webm'));
  if (!webm) throw new Error(`no video in ${dir} — was the shot recorded?`);
  return join(dir, webm);
}

async function ffmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
}

const shots: ShotRecord[] = readdirSync(SHOTS_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(SHOTS_DIR, f), 'utf8')) as ShotRecord)
  .sort((a, b) => a.order - b.order);
if (shots.length === 0) throw new Error('no shots recorded — run the tour first');

const filters: string[] = [];
const labels: string[] = [];
let timeline = 0;
let gifRange: [number, number] | null = null;

for (const [i, shot] of shots.entries()) {
  const parts = shot.segments.filter((s) => s.end - s.start > 0.05);
  let duration = 0;
  parts.forEach((seg, j) => {
    filters.push(
      `[${i}:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},` +
        `setpts=(PTS-STARTPTS)/${seg.speed},fps=${FPS}[s${i}_${j}]`,
    );
    duration += (seg.end - seg.start) / seg.speed;
  });
  const joined = parts.map((_, j) => `[s${i}_${j}]`).join('');
  filters.push(
    `${joined}concat=n=${parts.length}:v=1:a=0,` +
      `fade=t=in:st=0:d=${FADE},fade=t=out:st=${(duration - FADE).toFixed(3)}:d=${FADE}[shot${i}]`,
  );
  labels.push(`[shot${i}]`);
  if (shot.name.includes(GIF_SHOT)) gifRange = [timeline, timeline + duration];
  console.log(`${shot.name.padEnd(12)} ${duration.toFixed(1)} s`);
  timeline += duration;
}
filters.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0,format=yuv420p[out]`);

await ffmpeg([
  ...shots.flatMap((s) => ['-i', findVideo(s.videoDir)]),
  '-filter_complex',
  filters.join(';'),
  '-map',
  '[out]',
  '-c:v',
  'libx264',
  '-preset',
  'slow',
  '-crf',
  '23',
  '-movflags',
  '+faststart',
  MP4,
]);
console.log(`${MP4}: ${timeline.toFixed(1)} s, ${(statSync(MP4).size / 1e6).toFixed(1)} MB`);

if (gifRange) {
  const [from, to] = gifRange;
  await ffmpeg([
    '-ss',
    from.toFixed(2),
    '-to',
    to.toFixed(2),
    '-i',
    MP4,
    '-vf',
    `setpts=PTS/${GIF_SPEED},fps=12,scale=720:-1:flags=lanczos,split[a][b];` +
      `[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
    GIF,
  ]);
  if (existsSync(GIF)) console.log(`${GIF}: ${(statSync(GIF).size / 1e6).toFixed(1)} MB`);
}

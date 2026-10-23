/**
 * The product tour (docs/product-tour.md). Each test is one shot, recorded to
 * its own video; `cut-tour.ts` assembles them into the README video in order.
 * Serial on purpose: shot 2 acquires the album shots 3–4 then play.
 *
 * Everything on screen is the real app over the demo catalog. The only
 * off-camera help is the lyrics seed (the demo song has no lyrics source to
 * fetch from), done through the same curator endpoint a person would use.
 */
import type { APIRequestContext } from '@playwright/test';
import {
  DEMO_ALBUMS,
  coverSvg,
  demoLyricsLrc,
  demoLyricsPlain,
  demoTracks,
} from '../../core/src/demo/index.js';
import { bearer } from '../helpers';
import { expect, test, tourToken } from './shot';

test.describe.configure({ mode: 'serial' });

const ACQUIRED = DEMO_ALBUMS.find((a) => a.pool === 'acquirable')!;

async function albumId(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.get('/api/library/albums', { headers: bearer(tourToken()) });
  const albums = (await res.json()) as Array<{ id: string; name: string }>;
  const hit = albums.find((a) => a.name === title);
  if (!hit) throw new Error(`"${title}" is not in the library`);
  return hit.id;
}

test('1 home', async ({ page, shot }) => {
  await page.goto('/');
  await page.waitForTimeout(3000);
  shot.begin();
  await shot.caption('Your music. Found, organized, streamed.');
  await shot.glide({ x: 420, y: 300 }, 60);
  await shot.glide({ x: 820, y: 420 }, 80);
  await shot.hold(2200);
  shot.end();
});

test('2 acquire', async ({ page, request, shot }) => {
  await page.goto('/get');
  const input = page.getByTestId('search-input');
  await expect(input).toBeVisible();
  await page.waitForTimeout(800);
  shot.begin();
  await shot.caption('One search box, for any source.', 'top');
  await shot.click(input);
  await input.pressSequentially(ACQUIRED.artist, { delay: 75 });
  await shot.click(page.getByTestId('search-submit'));
  const card = page.getByRole('gridcell', { name: new RegExp(`^${ACQUIRED.title}`) });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await shot.hold(1500);

  await shot.caption('One tap. It picks the best match…', 'top');
  await shot.click(card.getByTestId('catalog-album-cover'));
  // Step off the card: the cursor would sit on the very status text it is showing.
  await shot.glide({ x: 470, y: 470 }, 20);
  await expect(page.getByText(/Best match found/)).toBeVisible({ timeout: 15_000 });
  await shot.hold(2200);
  await shot.caption('…downloads it, tags it, files it.', 'top');
  await shot.fast(4, async () => {
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/downloads/jobs', { headers: bearer(tourToken()) });
          const jobs = (await res.json()) as Array<{ albumTitle: string | null; stage: string }>;
          return jobs.find((j) => j.albumTitle === ACQUIRED.title)?.stage ?? '';
        },
        { timeout: 90_000, intervals: [500] },
      )
      .toBe('done');
    await page.waitForTimeout(1500);
  });
  await shot.hold(1500);
  shot.end();
});

test('3 library', async ({ page, request, shot }) => {
  const id = await albumId(request, ACQUIRED.title);
  // Off camera: the demo song has no lyrics source, so seed its LRC the way a
  // curator would, for the karaoke shot that follows.
  const detail = (await (
    await request.get(`/api/library/albums/${id}`, { headers: bearer(tourToken()) })
  ).json()) as { song: Array<{ id: string; title: string }> };
  const titleTrack = demoTracks(ACQUIRED)[0]!;
  const song = detail.song.find((s) => s.title === titleTrack.title)!;
  const seeded = await request.put(`/api/library/songs/${song.id}/lyrics`, {
    headers: bearer(tourToken()),
    data: { plain: demoLyricsPlain(), synced: demoLyricsLrc(titleTrack.tone) },
  });
  expect(seeded.ok()).toBeTruthy();

  await page.goto('/library');
  const tile = page.getByText(ACQUIRED.title, { exact: true }).first();
  await expect(tile).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  shot.begin();
  await shot.caption('It lands in your library, artwork and all.');
  await shot.glide(tile, 50);
  await shot.hold(1600);
  await shot.click(tile);
  await expect(page.getByRole('heading', { name: ACQUIRED.title })).toBeVisible();
  await shot.hold(2200);
  shot.end();
});

test('4 play', async ({ page, request, shot }) => {
  await page.goto(`/library/albums/${await albumId(request, ACQUIRED.title)}`);
  await expect(page.getByRole('heading', { name: ACQUIRED.title })).toBeVisible();
  await page.waitForTimeout(1500);
  shot.begin();
  await shot.caption('Press play.');
  await shot.click(page.getByRole('button', { name: /^Play/ }).first());
  await expect(page.getByTestId('player-title')).toBeVisible();
  await shot.hold(1500);
  await shot.click(page.getByTestId('player-track-info'));
  await expect(page.getByTestId('now-playing-waveform')).toBeVisible();
  await shot.caption('Now Playing, with the real waveform.', 'header');
  await shot.hold(2800);

  await shot.click(page.getByTestId('now-playing-tab-lyrics'));
  await shot.caption('Synced lyrics, line by line.', 'header');
  await shot.glide({ x: 900, y: 520 }, 40);
  await shot.hold(5500);

  await shot.click(page.getByTestId('now-playing-radio'));
  await shot.click(page.getByTestId('now-playing-tab-queue'));
  await shot.caption('Radio keeps it going, matched by tempo and mood.', 'header');
  await shot.glide({ x: 1060, y: 420 }, 50);
  await shot.hold(3500);
  shot.end();
});

test('5 outro', async ({ page, shot }) => {
  const covers = DEMO_ALBUMS.map(
    (a) =>
      `<div class="c">${coverSvg({ artist: a.artist, title: a.title, motif: a.cover }).replace(
        'width="1000" height="1000"',
        'width="132" height="132"',
      )}</div>`,
  ).join('');
  await page.setContent(`<!doctype html><html><head><style>
    body { margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 22px; background: radial-gradient(circle at 50% 35%, #1e1b4b, #09090b 70%);
      color: #fff; font-family: Inter, 'Helvetica Neue', Arial, sans-serif; }
    h1 { margin: 0; font-size: 92px; font-weight: 800; letter-spacing: -.03em; }
    p { margin: 0; }
    .tag { font-size: 34px; font-weight: 600; color: #c7d2fe; }
    .sub { font-size: 22px; color: #a1a1aa; }
    .url { margin-top: 10px; font-size: 26px; font-weight: 600; padding: 12px 26px; border-radius: 14px;
      background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.16); }
    .covers { display: flex; gap: 12px; margin-bottom: 12px; }
    .c { border-radius: 10px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
    .c svg { display: block; }
  </style></head><body>
    <div class="covers">${covers}</div>
    <h1>NicotinD</h1>
    <p class="tag">Find it. Own it. Play it anywhere.</p>
    <p class="sub">Self-hosted · open source · web, desktop, Android, iOS and TV</p>
    <p class="url">github.com/kevinch3/NicotinD</p>
  </body></html>`);
  await page.evaluate(() =>
    (window as unknown as { __tour?: { cursor(v: boolean): void } }).__tour?.cursor(false),
  );
  await page.waitForTimeout(600);
  shot.begin();
  await shot.hold(4500);
  shot.end();
});

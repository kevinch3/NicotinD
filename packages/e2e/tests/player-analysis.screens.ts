import { test, expect } from '../playground/fixtures';
import { shot } from '../playground/shot';
import { appeared, firstPresent } from '../playground/screens-ui';

/**
 * Live mobile flow — Player & analysis. Plays a real library track and walks the
 * Now Playing surface (shuffle/repeat/queue/radio) and the track-info sheet
 * (BPM/genre/acquisition), capturing a screenshot per state under
 * screenshots/mobile/player-analysis/ and recording timings/gaps via `obs`.
 *
 * Resilient by design: it waits for the (async) album grid before probing, and
 * the transport testids (`now-playing-shuffle/repeat/radio/queue`) are
 * best-effort — a deployed backend a release behind this branch won't have them
 * yet, so those shots are skipped with a note rather than failing the run.
 *
 * Read-mostly: shuffle/repeat/radio are client-side player state. The only
 * server-mutating steps (BPM analysis writes a tag; genre apply is an admin
 * write) are gated behind PLAYGROUND_ANALYZE=1, so the default run touches no
 * prod data.
 */
const FLOW = 'player-analysis';
const ANALYZE = process.env.PLAYGROUND_ANALYZE === '1';

test('player & analysis — mobile screens', async ({ page, obs }) => {
  // 1) Library → wait for the grid to render before deciding it's empty.
  await page.goto('/library');
  const firstAlbum = page.getByTestId('album-card').first();
  if (!(await appeared(firstAlbum, 15_000))) {
    obs.record({
      kind: 'degraded',
      title: 'No albums rendered — player flow skipped',
      severity: 'medium',
      suggestion: 'Library returned no album cards within 15s (empty library or slow API).',
    });
    return;
  }
  await firstAlbum.click();
  await expect(page).toHaveURL(/\/library\/albums\//);
  await expect(page.getByTestId('play-album')).toBeVisible();

  // 2) Play → mini player bar.
  await obs.time(
    'time to playable (album → mini player)',
    async () => {
      await page.getByTestId('play-album').click();
      await expect(page.getByTestId('player-title')).toBeVisible();
    },
    { warnMs: 4000 },
  );
  await shot(page, FLOW, 1, 'player bar', { settleMs: 600 });

  // 3) Expand into Now Playing.
  await page.getByTestId('player-title').click();
  await expect(page.getByText('Now Playing')).toBeVisible();
  await shot(page, FLOW, 2, 'now playing', { settleMs: 600 });

  // 4) Shuffle on (testid is new — best-effort on older deploys).
  const shuffle = await firstPresent(page.getByTestId('now-playing-shuffle'));
  if (shuffle) {
    await shuffle.click();
    await expect(shuffle).toHaveAttribute('aria-pressed', 'true');
    await shot(page, FLOW, 3, 'shuffle on', { settleMs: 250 });
  }

  // 5) Repeat (cycle once).
  const repeat = await firstPresent(page.getByTestId('now-playing-repeat'));
  if (repeat) {
    await repeat.click();
    await shot(page, FLOW, 4, 'repeat', { settleMs: 250 });
  }

  // 6) Queue ("Next up") — testid is new; fall back to the section heading.
  const queue = await firstPresent(
    page.getByTestId('now-playing-queue'),
    page.getByText('Next up'),
  );
  if (queue) {
    await queue.scrollIntoViewIfNeeded();
    await shot(page, FLOW, 5, 'queue', { settleMs: 250 });
  }

  // 7) Radio mode on (testid new; fall back to the labelled button).
  const radio = await firstPresent(
    page.getByTestId('now-playing-radio'),
    page.getByRole('button', { name: /^Radio/ }),
  );
  if (radio) {
    await radio.click();
    await shot(page, FLOW, 6, 'radio on', { settleMs: 250 });
  } else {
    obs.record({
      kind: 'enhancement',
      title: 'Now Playing transport testids not present on this deploy',
      severity: 'low',
      detail: 'now-playing-shuffle/repeat/radio/queue land with this branch.',
    });
  }

  // 8) Track-info sheet.
  await page.getByTestId('now-playing-info').click();
  await expect(page.getByTestId('track-info-identity')).toBeVisible();
  await shot(page, FLOW, 7, 'track info', { settleMs: 700 });

  // 9) Analysis section (BPM / genre).
  const analysis = page.getByTestId('analysis-section');
  if (await appeared(analysis, 6000)) {
    await analysis.scrollIntoViewIfNeeded();
    await shot(page, FLOW, 8, 'analysis idle', { settleMs: 300 });

    if (ANALYZE) {
      const bpmBtn = await firstPresent(page.getByTestId('analyze-bpm-button'));
      if (bpmBtn) {
        await obs.time(
          'BPM analysis',
          async () => {
            await bpmBtn.click();
            await expect(page.getByTestId('bpm-value')).toBeVisible({ timeout: 90_000 });
          },
          { warnMs: 8000 },
        );
        await shot(page, FLOW, 9, 'bpm analyzed', { settleMs: 300 });
      }

      const genreBtn = await firstPresent(page.getByTestId('verify-genre-button'));
      if (genreBtn) {
        await genreBtn.click();
        const suggestion = page.getByTestId('genre-suggestion');
        if (await appeared(suggestion, 20_000)) {
          await shot(page, FLOW, 10, 'genre suggestion', { settleMs: 400 });
          const applyBtn = await firstPresent(page.getByTestId('apply-genre-button'));
          if (applyBtn) {
            await applyBtn.click();
            await shot(page, FLOW, 11, 'genre applied', { settleMs: 400 });
          }
        } else {
          obs.record({
            kind: 'enhancement',
            title: 'No genre suggestion returned',
            severity: 'low',
            detail: 'verifyGenre yielded nothing (Lidarr unconfigured or no match).',
            suggestion: 'Confirm Lidarr is reachable for genre verification.',
          });
        }
      }
    }
  } else {
    obs.record({
      kind: 'gap',
      title: 'Track-info analysis section absent',
      severity: 'medium',
      detail: 'Analysis (BPM/genre) is gated on ffmpeg availability.',
      suggestion: 'Verify ffmpeg is on PATH on the prod host.',
    });
  }

  // 10) Acquisition provenance section.
  const acq = page.getByTestId('acquisition-section');
  if (await appeared(acq, 4000)) {
    await acq.scrollIntoViewIfNeeded();
    await shot(page, FLOW, 12, 'acquisition', { settleMs: 300 });
    const method = await firstPresent(page.getByTestId('acquisition-method'));
    if (method) {
      obs.record({
        kind: 'metric',
        title: 'Acquisition method shown',
        value: (await method.innerText()).trim(),
        severity: 'info',
      });
    }
  }
});

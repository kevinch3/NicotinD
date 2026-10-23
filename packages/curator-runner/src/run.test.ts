import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunnerConfig } from './config.js';
import { ingestInProgress, runCuration, targetsMet, RunnerError, type RunDeps } from './run.js';
import { AttemptStore } from './state.js';
import { FakeMcp, ScriptedModel, verdict } from './testing.js';

const NOW = Date.UTC(2026, 9, 18, 4, 30);
let dir: string;
let store: AttemptStore;

const cfg = (over: Partial<RunnerConfig> = {}): RunnerConfig => ({
  mcpUrl: 'http://x/api/mcp',
  mcpToken: 'nca_x',
  provider: 'openai',
  modelBaseUrl: 'http://ollama/v1',
  model: 'qwen',
  modelApiKey: null,
  apply: 'propose',
  samples: 3,
  temperature: 0.4,
  maxClusters: 20,
  maxMinutes: 30,
  targets: { lowInformation: null, missing: null },
  stateDb: ':memory:',
  cooldownDays: 30,
  cardLanguage: 'en',
  ...over,
});

/** Green Velvet's DJ mix: two catch-all tracks, one with a real genre beside the catch-all. */
function seed(mcp: FakeMcp): void {
  mcp.artists.push({ id: 'ar-gv', name: 'Green Velvet', country: 'US', albumIds: ['al-mix'] });
  mcp.albums.set('al-mix', {
    id: 'al-mix',
    name: 'Factory Town (DJ Mix)',
    artist: 'Green Velvet',
    year: 2026,
    songs: [
      { id: 's1', title: 'Percolator', artist: 'Cajmere', genres: ['Electronic'] },
      { id: 's2', title: 'Street Slang', artist: 'CASSIMM', genres: ['Electronic'] },
      // A replace here would drop Techno: never a candidate.
      { id: 's3', title: 'Flash', artist: 'Green Velvet', genres: ['Electronic', 'Techno'] },
    ],
  });
  mcp.lowInformationArtists = ['ar-gv'];
}

function deps(mcp: FakeMcp, model: ScriptedModel): RunDeps {
  return { mcp, model, store, now: () => NOW, log: () => {} };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'curator-runner-'));
  store = new AttemptStore(join(dir, 'state.sqlite'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('runCuration', () => {
  it('refuses to run on any token that is not refiner:auto', async () => {
    const mcp = new FakeMcp();
    mcp.scope = 'refiner:curate';
    await expect(
      runCuration(cfg(), deps(mcp, new ScriptedModel([verdict('Tech House')])), { dryRun: false }),
    ).rejects.toBeInstanceOf(RunnerError);
    expect(mcp.calls).toHaveLength(0);
  });

  it('propose mode files one card per album, offering only the songs a replace cannot hurt', async () => {
    const mcp = new FakeMcp();
    seed(mcp);
    const report = await runCuration(cfg(), deps(mcp, new ScriptedModel([verdict('Tech House')])), {
      dryRun: false,
    });

    expect(mcp.writes()).toEqual([]);
    expect(mcp.flags).toHaveLength(1);
    const flag = mcp.flags[0]!;
    expect(flag).toMatchObject({ targetKind: 'album', targetId: 'al-mix', caseKind: 'listen' });
    const options = flag.options as Array<{ label: string; effect: unknown }>;
    expect(options[0]).toMatchObject({
      label: 'Tech House',
      effect: { type: 'song-genre', songIds: ['s1', 's2'], genre: 'Tech House' },
    });
    expect(report.outcomes.map((o) => o.result)).toEqual(['proposed']);
    expect(report.stop).toBe('worklist-exhausted');
  });

  it('auto mode writes a unanimous high verdict and reads it back', async () => {
    const mcp = new FakeMcp();
    seed(mcp);
    const report = await runCuration(
      cfg({ apply: 'auto' }),
      deps(mcp, new ScriptedModel([verdict('Tech House')])),
      { dryRun: false },
    );
    expect(mcp.writes()).toEqual(['s1', 's2']);
    expect(report.outcomes[0]).toMatchObject({ result: 'applied', written: 2, verified: 2 });
    expect(report.before.lowInformation).toBe(2);
    expect(report.after.lowInformation).toBe(0);
  });

  it('auto mode still only proposes when the samples disagree or any is low confidence', async () => {
    for (const script of [
      [verdict('Tech House'), verdict('Techno'), verdict('Tech House')],
      [verdict('Tech House'), verdict('Tech House', 'low'), verdict('Tech House')],
    ]) {
      const mcp = new FakeMcp();
      seed(mcp);
      await runCuration(cfg({ apply: 'auto' }), deps(mcp, new ScriptedModel(script)), {
        dryRun: false,
      });
      expect(mcp.writes()).toEqual([]);
      expect(mcp.flags).toHaveLength(1);
      store.close();
      store = new AttemptStore(join(dir, `s-${Math.random()}.sqlite`));
    }
  });

  it('leaves the album alone when the model mostly answers unknown', async () => {
    const mcp = new FakeMcp();
    seed(mcp);
    const report = await runCuration(
      cfg({ apply: 'auto' }),
      deps(
        mcp,
        new ScriptedModel([
          verdict('unknown', 'low'),
          verdict('unknown', 'low'),
          verdict('Techno'),
        ]),
      ),
      { dryRun: false },
    );
    expect(mcp.writes()).toEqual([]);
    expect(mcp.flags).toEqual([]);
    expect(report.outcomes[0]!.result).toBe('skipped');
  });

  it('a dry run asks the model but writes and records nothing', async () => {
    const mcp = new FakeMcp();
    seed(mcp);
    const report = await runCuration(
      cfg({ apply: 'auto' }),
      deps(mcp, new ScriptedModel([verdict('Tech House')])),
      { dryRun: true },
    );
    expect(mcp.writes()).toEqual([]);
    expect(mcp.flags).toEqual([]);
    expect(report.outcomes[0]).toMatchObject({ result: 'dry-run', note: 'would write Tech House' });
    expect(store.isCoolingDown('al-mix', NOW, 30)).toBe(false);
  });

  it('does not revisit an album inside the cooldown', async () => {
    const mcp = new FakeMcp();
    seed(mcp);
    const model = new ScriptedModel([verdict('Tech House')]);
    await runCuration(cfg(), deps(mcp, model), { dryRun: false });
    const asked = model.prompts.length;
    const second = await runCuration(cfg(), deps(mcp, model), { dryRun: false });
    expect(model.prompts.length).toBe(asked);
    expect(second.outcomes).toEqual([]);
    expect(mcp.flags).toHaveLength(1);
  });

  it('stops at the server budget instead of retrying', async () => {
    const mcp = new FakeMcp();
    seed(mcp);
    mcp.genreBudget = 1;
    const report = await runCuration(
      cfg({ apply: 'auto' }),
      deps(mcp, new ScriptedModel([verdict('Tech House')])),
      { dryRun: false },
    );
    expect(report.stop).toBe('budget-exhausted');
    expect(mcp.writes()).toEqual(['s1', 's2']);
  });

  it('skips the whole run while an ingest is landing songs', async () => {
    const mcp = new FakeMcp();
    seed(mcp);
    mcp.recentLandings = [1, 2, 3, 4, 5].map((i) => NOW - i * 60_000);
    const model = new ScriptedModel([verdict('Tech House')]);
    const report = await runCuration(cfg(), deps(mcp, model), { dryRun: false });
    expect(report.stop).toBe('ingest-in-progress');
    expect(model.prompts).toHaveLength(0);
  });

  it('ends the run after repeated model failures', async () => {
    const mcp = new FakeMcp();
    for (const n of [1, 2, 3, 4]) {
      mcp.albums.set(`al${n}`, {
        id: `al${n}`,
        name: `A${n}`,
        artist: 'X',
        year: null,
        songs: [{ id: `s${n}`, title: 't', artist: 'X', genres: [] }],
      });
    }
    const report = await runCuration(cfg(), deps(mcp, new ScriptedModel([new Error('down')])), {
      dryRun: false,
    });
    expect(report.stop).toBe('model-unavailable');
    expect(report.outcomes).toHaveLength(3);
  });

  it('stops once the targets are met', async () => {
    const mcp = new FakeMcp();
    seed(mcp);
    const report = await runCuration(
      cfg({ targets: { lowInformation: 5, missing: null } }),
      deps(mcp, new ScriptedModel([verdict('Tech House')])),
      { dryRun: false },
    );
    expect(report.stop).toBe('targets-met');
    expect(report.outcomes).toEqual([]);
  });

  it('shows the model only the evidence and the vocabulary', async () => {
    const mcp = new FakeMcp();
    seed(mcp);
    const model = new ScriptedModel([verdict('Tech House')]);
    await runCuration(cfg({ samples: 1 }), deps(mcp, model), { dryRun: true });
    const p = model.prompts[0]!;
    expect(p.vocabulary).toEqual(['Tech House', 'Techno', 'Reggae']);
    expect(p.user).toContain('Percolator | Cajmere | Electronic');
    expect(p.user).toContain('Artist origin: US');
  });
});

describe('ingestInProgress', () => {
  it('counts distinct recent landings, not rows — a re-land shares one timestamp', async () => {
    const mcp = new FakeMcp();
    mcp.recentLandings = Array(25).fill(NOW - 60_000);
    expect(await ingestInProgress(mcp, NOW)).toBe(false);
    mcp.recentLandings = [1, 2, 3, 4, 5].map((i) => NOW - i * 60_000);
    expect(await ingestInProgress(mcp, NOW)).toBe(true);
    mcp.recentLandings = [1, 2, 3, 4, 5].map((i) => NOW - i * 3_600_000);
    expect(await ingestInProgress(mcp, NOW)).toBe(false);
  });
});

describe('targetsMet', () => {
  it('needs at least one target, and every set target met', () => {
    const m = { lowInformation: 10, missing: 50 };
    expect(targetsMet({ lowInformation: null, missing: null }, m)).toBe(false);
    expect(targetsMet({ lowInformation: 10, missing: null }, m)).toBe(true);
    expect(targetsMet({ lowInformation: 10, missing: 40 }, m)).toBe(false);
  });
});

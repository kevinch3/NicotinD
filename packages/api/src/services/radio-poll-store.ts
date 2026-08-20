import { randomBytes, randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type {
  PublicPollScenario,
  PublicPollTrack,
  PublicPollView,
  PublicPollVoteBody,
  RadioPollCandidateSnapshot,
  RadioPollResults,
  RadioPollScenarioSnapshot,
  RadioPollSettings,
  RadioPollSummary,
} from '@nicotind/core';
import type { GeneratedScenario } from './radio-poll-generate.js';
import { describeFilter } from './radio-poll-generate.js';

/** A vote-request problem the route maps to a 400. */
export class RadioPollVoteError extends Error {}
/** Thrown when a new rater would exceed the per-poll cap (route → 409). */
export class RadioPollRaterCapError extends Error {}

/** Light abuse guard: a self-hosted poll should never see this many people. */
export const MAX_RATERS_PER_POLL = 1000;
export const MAX_NOTE_LENGTH = 500;
export const RATER_KEY_MIN = 8;
export const RATER_KEY_MAX = 64;

export interface RadioPollRow {
  id: string;
  token: string;
  name: string;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  closed_at: number | null;
  settings_json: string;
  engine_version: string | null;
  formula_version: string | null;
}

export interface RadioPollScenarioRow {
  id: string;
  poll_id: string;
  position: number;
  kind: 'seed' | 'filter';
  seed_song_id: string | null;
  snapshot: RadioPollScenarioSnapshot;
}

export function createPoll(
  db: Database,
  args: {
    name: string;
    createdBy: string;
    settings: RadioPollSettings;
    scenarios: GeneratedScenario[];
    engineVersion?: string | null;
    formulaVersion?: string | null;
    expiresAt?: number | null;
    now?: number;
  },
): { id: string; token: string } {
  const id = randomUUID();
  const token = randomBytes(16).toString('base64url');
  const now = args.now ?? Date.now();
  const insert = db.transaction(() => {
    db.run(
      `INSERT INTO radio_polls (id, token, name, created_by, created_at, expires_at, closed_at, settings_json, engine_version, formula_version)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        id,
        token,
        args.name,
        args.createdBy,
        now,
        args.expiresAt ?? null,
        JSON.stringify(args.settings),
        args.engineVersion ?? null,
        args.formulaVersion ?? null,
      ],
    );
    for (const s of args.scenarios) {
      db.run(
        `INSERT INTO radio_poll_scenarios (id, poll_id, position, kind, seed_song_id, snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [s.id, id, s.position, s.kind, s.seedSongId, JSON.stringify(s.snapshot)],
      );
    }
  });
  insert();
  return { id, token };
}

export function getPollByToken(db: Database, token: string): RadioPollRow | null {
  return (
    db.query<RadioPollRow, [string]>('SELECT * FROM radio_polls WHERE token = ?').get(token) ?? null
  );
}

export function getPollById(db: Database, id: string): RadioPollRow | null {
  return db.query<RadioPollRow, [string]>('SELECT * FROM radio_polls WHERE id = ?').get(id) ?? null;
}

/** Open / closed-by-admin / past-expiry — the public route's 410 discriminator. */
export function pollStatus(
  poll: Pick<RadioPollRow, 'closed_at' | 'expires_at'>,
  now: number = Date.now(),
): 'open' | 'closed' | 'expired' {
  if (poll.closed_at != null) return 'closed';
  if (poll.expires_at != null && now >= poll.expires_at) return 'expired';
  return 'open';
}

export function listScenarios(db: Database, pollId: string): RadioPollScenarioRow[] {
  const rows = db
    .query<Omit<RadioPollScenarioRow, 'snapshot'> & { snapshot_json: string }, [string]>(
      'SELECT * FROM radio_poll_scenarios WHERE poll_id = ? ORDER BY position',
    )
    .all(pollId);
  return rows.map((r) => ({
    id: r.id,
    poll_id: r.poll_id,
    position: r.position,
    kind: r.kind,
    seed_song_id: r.seed_song_id,
    snapshot: JSON.parse(r.snapshot_json) as RadioPollScenarioSnapshot,
  }));
}

export function parseSettings(poll: Pick<RadioPollRow, 'settings_json'>): RadioPollSettings {
  return JSON.parse(poll.settings_json) as RadioPollSettings;
}

/** `url` is composed by the route (needs the request origin). */
export type StoredPollSummary = Omit<RadioPollSummary, 'url'>;

export function listPollSummaries(db: Database): StoredPollSummary[] {
  const rows = db
    .query<RadioPollRow & { scenario_count: number; vote_count: number; rater_count: number }, []>(
      `SELECT p.*,
              (SELECT COUNT(*) FROM radio_poll_scenarios s WHERE s.poll_id = p.id) AS scenario_count,
              (SELECT COUNT(*) FROM radio_poll_votes v
                 JOIN radio_poll_scenarios s ON s.id = v.scenario_id
                WHERE s.poll_id = p.id) AS vote_count,
              (SELECT COUNT(DISTINCT v.rater_key) FROM radio_poll_votes v
                 JOIN radio_poll_scenarios s ON s.id = v.scenario_id
                WHERE s.poll_id = p.id) AS rater_count
       FROM radio_polls p ORDER BY p.created_at DESC`,
    )
    .all();
  return rows.map((r) => ({
    id: r.id,
    token: r.token,
    name: r.name,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    closedAt: r.closed_at,
    scenarioCount: r.scenario_count,
    voteCount: r.vote_count,
    raterCount: r.rater_count,
    formulaVersion: r.formula_version ?? null,
  }));
}

function summaryFor(db: Database, poll: RadioPollRow): StoredPollSummary {
  const counts = db
    .query<
      { scenario_count: number; vote_count: number; rater_count: number },
      [string, string, string]
    >(
      `SELECT (SELECT COUNT(*) FROM radio_poll_scenarios s WHERE s.poll_id = ?) AS scenario_count,
              (SELECT COUNT(*) FROM radio_poll_votes v
                 JOIN radio_poll_scenarios s ON s.id = v.scenario_id WHERE s.poll_id = ?) AS vote_count,
              (SELECT COUNT(DISTINCT v.rater_key) FROM radio_poll_votes v
                 JOIN radio_poll_scenarios s ON s.id = v.scenario_id WHERE s.poll_id = ?) AS rater_count`,
    )
    .get(poll.id, poll.id, poll.id);
  return {
    id: poll.id,
    token: poll.token,
    name: poll.name,
    createdAt: poll.created_at,
    expiresAt: poll.expires_at,
    closedAt: poll.closed_at,
    scenarioCount: counts?.scenario_count ?? 0,
    voteCount: counts?.vote_count ?? 0,
    raterCount: counts?.rater_count ?? 0,
    formulaVersion: poll.formula_version ?? null,
  };
}

function publicTrack(c: { song: RadioPollCandidateSnapshot['song'] }): PublicPollTrack {
  return {
    id: c.song.id,
    title: c.song.title,
    artist: c.song.artist,
    album: c.song.album ?? '',
    coverArt: c.song.coverArt ?? c.song.albumId ?? c.song.id,
    duration: c.song.duration ?? 0,
  };
}

/**
 * The rater-facing projection: strips features, scores, explanations and true
 * rank (leaking the engine's own confidence would bias the vote), orders
 * candidates by the frozen `displayOrder`.
 */
export function publicPollView(
  poll: RadioPollRow,
  scenarios: RadioPollScenarioRow[],
  media: { jwt: string; expiresAt: number },
): PublicPollView {
  const settings = parseSettings(poll);
  return {
    poll: {
      name: poll.name,
      scenarioCount: scenarios.length,
      nextUpCount: settings.nextUpCount,
    },
    scenarios: scenarios.map((s): PublicPollScenario => {
      const candidates = [...s.snapshot.candidates].sort((a, b) => a.displayOrder - b.displayOrder);
      return {
        id: s.id,
        position: s.position,
        seed: s.snapshot.seed ? publicTrack(s.snapshot.seed) : null,
        // A station has no seed track, so the rater needs to be told what the
        // station IS — without it the wizard renders an unexplained list of
        // songs and the votes mean nothing.
        ...(s.snapshot.filter ? { filterLabel: describeFilter(s.snapshot.filter) } : {}),
        candidates: candidates.map(publicTrack),
      };
    }),
    mediaJwt: media.jwt,
    mediaJwtExpiresAt: media.expiresAt,
  };
}

/**
 * Validate + upsert one rater's votes. Every scenario must belong to the poll
 * and every candidate to that scenario's frozen snapshot; a repeat vote on the
 * same (scenario, rater, candidate) updates in place — a change of mind, never
 * a double count.
 */
export function recordVotes(
  db: Database,
  pollId: string,
  body: PublicPollVoteBody,
  now: number = Date.now(),
): { recorded: number } {
  const raterKey = typeof body.raterKey === 'string' ? body.raterKey.trim() : '';
  if (raterKey.length < RATER_KEY_MIN || raterKey.length > RATER_KEY_MAX) {
    throw new RadioPollVoteError(`raterKey must be ${RATER_KEY_MIN}..${RATER_KEY_MAX} characters`);
  }
  if (!Array.isArray(body.votes) || body.votes.length === 0) {
    throw new RadioPollVoteError('votes must be a non-empty array');
  }

  const scenarios = listScenarios(db, pollId);
  const candidatesByScenario = new Map<string, Set<string>>(
    scenarios.map((s) => [s.id, new Set(s.snapshot.candidates.map((c) => c.song.id))]),
  );
  const totalCandidates = scenarios.reduce((n, s) => n + s.snapshot.candidates.length, 0);
  if (body.votes.length > totalCandidates) {
    throw new RadioPollVoteError('more votes than the poll has candidates');
  }

  for (const v of body.votes) {
    const candidateIds = candidatesByScenario.get(v.scenarioId);
    if (!candidateIds) throw new RadioPollVoteError(`unknown scenario: ${v.scenarioId}`);
    if (!candidateIds.has(v.candidateSongId)) {
      throw new RadioPollVoteError(`candidate not in scenario: ${v.candidateSongId}`);
    }
    if (v.verdict !== 'up' && v.verdict !== 'down') {
      throw new RadioPollVoteError(`verdict must be "up" or "down"`);
    }
    if (v.note != null && (typeof v.note !== 'string' || v.note.length > MAX_NOTE_LENGTH)) {
      throw new RadioPollVoteError(`note must be at most ${MAX_NOTE_LENGTH} characters`);
    }
  }

  // Abuse guard: cap distinct raters per poll. Existing raters can always
  // update their own votes.
  const known = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM radio_poll_votes v
         JOIN radio_poll_scenarios s ON s.id = v.scenario_id
        WHERE s.poll_id = ? AND v.rater_key = ?`,
    )
    .get(pollId, raterKey);
  if ((known?.n ?? 0) === 0) {
    const raters = db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(DISTINCT v.rater_key) AS n FROM radio_poll_votes v
           JOIN radio_poll_scenarios s ON s.id = v.scenario_id WHERE s.poll_id = ?`,
      )
      .get(pollId);
    if ((raters?.n ?? 0) >= MAX_RATERS_PER_POLL) {
      throw new RadioPollRaterCapError('this poll has reached its rater limit');
    }
  }

  const write = db.transaction(() => {
    for (const v of body.votes) {
      db.run(
        `INSERT INTO radio_poll_votes (scenario_id, rater_key, candidate_song_id, verdict, note, at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scenario_id, rater_key, candidate_song_id)
         DO UPDATE SET verdict = excluded.verdict, note = excluded.note, at = excluded.at`,
        [v.scenarioId, raterKey, v.candidateSongId, v.verdict, v.note ?? null, now],
      );
    }
  });
  write();
  return { recorded: body.votes.length };
}

/** Full admin/diagnosis read: frozen snapshots joined with per-candidate tallies. */
export function pollResults(
  db: Database,
  poll: RadioPollRow,
): Omit<RadioPollResults, 'poll'> & {
  poll: StoredPollSummary;
} {
  const scenarios = listScenarios(db, poll.id);
  const tallies = db
    .query<
      { scenario_id: string; candidate_song_id: string; verdict: 'up' | 'down'; n: number },
      [string]
    >(
      `SELECT v.scenario_id, v.candidate_song_id, v.verdict, COUNT(*) AS n
         FROM radio_poll_votes v
         JOIN radio_poll_scenarios s ON s.id = v.scenario_id
        WHERE s.poll_id = ?
        GROUP BY v.scenario_id, v.candidate_song_id, v.verdict`,
    )
    .all(poll.id);
  const tally = new Map<string, { up: number; down: number }>();
  for (const t of tallies) {
    const key = `${t.scenario_id} ${t.candidate_song_id}`;
    const entry = tally.get(key) ?? { up: 0, down: 0 };
    entry[t.verdict] += t.n;
    tally.set(key, entry);
  }
  return {
    poll: summaryFor(db, poll),
    settings: parseSettings(poll),
    scenarios: scenarios.map((s) => ({
      id: s.id,
      position: s.position,
      kind: s.kind,
      seed: s.snapshot.seed,
      centroid: s.snapshot.centroid,
      filter: s.snapshot.filter,
      weights: s.snapshot.weights,
      candidates: s.snapshot.candidates.map((c) => {
        const entry = tally.get(`${s.id} ${c.song.id}`);
        return { ...c, up: entry?.up ?? 0, down: entry?.down ?? 0 };
      }),
    })),
  };
}

export function closePoll(db: Database, id: string, now: number = Date.now()): boolean {
  db.run('UPDATE radio_polls SET closed_at = ? WHERE id = ? AND closed_at IS NULL', [now, id]);
  const changed = db.query<{ n: number }, []>('SELECT changes() AS n').get();
  return (changed?.n ?? 0) > 0;
}

export function deletePoll(db: Database, id: string): boolean {
  // Explicit child deletes: FK cascade needs PRAGMA foreign_keys, which this
  // deliberately doesn't rely on (same stance as acquisition-job-store).
  const remove = db.transaction(() => {
    db.run(
      `DELETE FROM radio_poll_votes WHERE scenario_id IN
         (SELECT id FROM radio_poll_scenarios WHERE poll_id = ?)`,
      [id],
    );
    db.run('DELETE FROM radio_poll_scenarios WHERE poll_id = ?', [id]);
    db.run('DELETE FROM radio_polls WHERE id = ?', [id]);
  });
  remove();
  const changed = db.query<{ n: number }, []>('SELECT changes() AS n').get();
  return (changed?.n ?? 0) > 0;
}

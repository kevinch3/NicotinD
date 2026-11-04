/**
 * Joint credits the library has not resolved: a list credit (`A/B`, `A; B`) whose
 * song links fewer artists than the credit names. See docs/library-audit.md.
 */
import type { Database } from 'bun:sqlite';
import {
  CASE_TEXT_LIMITS,
  JOINT_ONE_ACT_OPTION_ID,
  JOINT_SPLIT_OPTION_ID,
  type CaseOption,
} from '@nicotind/core';
import { normalizeArtistForGrouping } from './album-grouping.js';
import { loadSplitAuthority } from './artist-identity-store.js';
import {
  isKnownMember,
  listCreditMembers,
  listCreditSides,
  primaryCredit,
  type KnownArtistSets,
} from './artist-split.js';
import { createCurationFlag, type CurationFlag } from './curation-flags.js';
import { artistIdFor } from './library-scanner.js';

export interface JointCreditRow {
  credit: string;
  songs: number;
  /** The fewest artists linked by any song carrying this credit. */
  links: number;
  songId: string;
}

export interface JointCreditFinding {
  credit: string;
  songs: number;
  songId: string;
  members: { name: string; known: boolean }[];
  /** `auto`: the scanner's list rule settles it. `human`: no name in it is a known artist. */
  decision: 'auto' | 'human';
}

/** The members a credit should resolve to, or null when it is not an open list credit. */
function openCredit(
  credit: string,
  known: KnownArtistSets,
): Pick<JointCreditFinding, 'members' | 'decision'> | null {
  const primary = primaryCredit(credit);
  const sides = listCreditSides(primary);
  if (sides.length < 2) return null;
  const key = normalizeArtistForGrouping(primary);
  if (known.canonicalWhole?.has(key) || known.explicitSplits?.has(key)) return null;
  const members = listCreditMembers(primary, known);
  const auto = members.length > 1 && members.some((m) => isKnownMember(m, known));
  return {
    decision: auto ? 'auto' : 'human',
    members: (auto ? members : sides).map((name) => ({
      name,
      known: isKnownMember(name, known),
    })),
  };
}

export function findUnresolvedJointCredits(
  rows: readonly JointCreditRow[],
  known: KnownArtistSets,
): JointCreditFinding[] {
  const out: JointCreditFinding[] = [];
  for (const r of rows) {
    const open = openCredit(r.credit, known);
    if (!open || r.links >= open.members.length) continue;
    out.push({ credit: r.credit, songs: r.songs, songId: r.songId, ...open });
  }
  return out.sort((a, b) => b.songs - a.songs || a.credit.localeCompare(b.credit, 'en'));
}

const LINK_COUNTS = `LEFT JOIN (
    SELECT song_id, COUNT(*) AS n FROM library_song_artists GROUP BY song_id
  ) l ON l.song_id = s.id`;

function jointCreditRows(db: Database): JointCreditRow[] {
  return db
    .query<JointCreditRow, []>(
      `SELECT s.artist AS credit, COUNT(*) AS songs, MIN(s.id) AS songId,
              MIN(COALESCE(l.n, 0)) AS links
         FROM library_songs s ${LINK_COUNTS}
        WHERE s.artist LIKE '%/%' OR s.artist LIKE '%;%' OR s.artist LIKE '%  %'
        GROUP BY s.artist`,
    )
    .all();
}

export function jointCreditFindings(db: Database): JointCreditFinding[] {
  return findUnresolvedJointCredits(jointCreditRows(db), loadSplitAuthority(db));
}

export interface JointCreditFacts {
  metric: { credits: number; songs: number; auto: number; human: number; fakeArtists: number };
  worklist: (JointCreditFinding & { artistId: string | null })[];
}

export function jointCreditFacts(db: Database, sample: number): JointCreditFacts {
  const findings = jointCreditFindings(db);
  const fake = new Set(
    db
      .query<{ id: string }, []>('SELECT id FROM library_artists WHERE split_compound = 0')
      .all()
      .map((r) => r.id),
  );
  const rowOf = (credit: string) => {
    const id = artistIdFor(credit);
    return fake.has(id) ? id : null;
  };
  return {
    metric: {
      credits: findings.length,
      songs: findings.reduce((n, f) => n + f.songs, 0),
      auto: findings.filter((f) => f.decision === 'auto').length,
      human: findings.filter((f) => f.decision === 'human').length,
      fakeArtists: findings.filter((f) => rowOf(f.credit) !== null).length,
    },
    worklist: findings.slice(0, sample).map((f) => ({ ...f, artistId: rowOf(f.credit) })),
  };
}

/** Whether the scanner's list rule splits this credit, so no lookup or human is needed. */
export function listRuleSplits(credit: string, known: KnownArtistSets): boolean {
  return openCredit(credit, known)?.decision === 'auto';
}

/** One authority load per request, and none when no flag needs it. */
export function lazyAuthority(db: Database): () => KnownArtistSets {
  let loaded: KnownArtistSets | undefined;
  return () => (loaded ??= loadSplitAuthority(db));
}

const capped = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

export const jointCreditQuestion = (credit: string) =>
  capped(`Is "${credit}" several artists?`, CASE_TEXT_LIMITS.question);

/** The card's two answers. The web localizes both through their ids. */
export function jointCreditOptions(credit: string, members: string[]): CaseOption[] {
  return [
    {
      id: JOINT_SPLIT_OPTION_ID,
      label: capped(`Separate: ${members.join(' + ')}`, CASE_TEXT_LIMITS.label),
      rationale: '',
      effect: { type: 'artist-split', rawName: credit, members },
    },
    {
      id: JOINT_ONE_ACT_OPTION_ID,
      label: 'One act',
      rationale: '',
      effect: { type: 'artist-single', rawName: credit },
    },
  ];
}

const ABOUT_THE_CREDIT = /\b(misplaced|mistagged)\b/;

/**
 * A listener's report on a song with an open list credit, carrying the card that
 * answers it. Derived on read, so reports already filed get one and a credit that
 * has since resolved stops offering it. A filed card is never replaced.
 */
export function withJointCreditCard(
  db: Database,
  flag: CurationFlag,
  authority: () => KnownArtistSets = () => loadSplitAuthority(db),
): CurationFlag {
  if (flag.optionsJson || flag.targetKind !== 'song' || !ABOUT_THE_CREDIT.test(flag.reason)) {
    return flag;
  }
  const row = db
    .query<JointCreditRow, [string]>(
      `SELECT s.artist AS credit, 1 AS songs, s.id AS songId, COALESCE(l.n, 0) AS links
         FROM library_songs s ${LINK_COUNTS} WHERE s.id = ?`,
    )
    .get(flag.targetId);
  const finding = row && findUnresolvedJointCredits([row], authority())[0];
  if (!finding) return flag;
  const credit = primaryCredit(finding.credit);
  return {
    ...flag,
    caseKind: 'identity',
    question: jointCreditQuestion(credit),
    optionsJson: JSON.stringify(
      jointCreditOptions(
        credit,
        finding.members.map((m) => m.name),
      ),
    ),
  };
}

const IDENTITY_TASK_ACTOR = 'system:artist-identity';

/**
 * File the card for a list credit nothing could resolve: no name in it is known
 * and Lidarr has no answer. Once per credit: a card someone closed is an answer,
 * and the weekly re-check must not ask again.
 */
export function fileJointCreditCard(db: Database, credit: string, members: string[]): boolean {
  const song = db
    .query<{ id: string }, [string]>('SELECT id FROM library_songs WHERE artist = ? LIMIT 1')
    .get(credit);
  if (!song) return false;
  const filed = db
    .query(
      `SELECT 1 FROM curation_flags WHERE target_kind = 'song' AND target_id = ? AND created_by = ?`,
    )
    .get(song.id, IDENTITY_TASK_ACTOR);
  if (filed) return false;
  createCurationFlag(db, {
    targetKind: 'song',
    targetId: song.id,
    reason: `No name in "${credit}" is a known artist, and Lidarr has no match for it.`,
    createdBy: IDENTITY_TASK_ACTOR,
    caseKind: 'identity',
    question: jointCreditQuestion(credit),
    optionsJson: JSON.stringify(jointCreditOptions(credit, members)),
  });
  return true;
}

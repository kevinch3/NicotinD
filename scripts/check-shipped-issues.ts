/**
 * Report open issues that look already-shipped (issue #257).
 *
 *   bun run scripts/check-shipped-issues.ts            # since the last release tag
 *   bun run scripts/check-shipped-issues.ts --all      # whole history
 *   bun run scripts/check-shipped-issues.ts --json
 *
 * WHY: `Closes #N` in a PR body closes the issue on merge; `(#N)` in a commit
 * subject only *links* it. The repo used both, so work shipped while its issue
 * stayed open — six found in one audit (#257), five more after that. An open
 * list that includes finished work makes every future triage pass re-derive
 * context for work that's done, and hides the real remaining scope.
 *
 * DELIBERATELY A REPORT, NOT A GATE. A commit can legitimately reference an
 * issue without resolving it — partial work, a follow-up, a revert — so a hard
 * failure here would be wrong often enough to get muted. This lists candidates
 * a human confirms, which is the honest shape for a heuristic that cannot know
 * intent. It exits 0 even when it finds something.
 *
 * Needs the `gh` CLI authenticated (it reads the open-issue list); without it
 * the script says so and exits 0 rather than failing a pipeline.
 */
import { execFileSync } from 'node:child_process';

/**
 * Options for every `git` read here. The `maxBuffer` is load-bearing: whole
 * history (`--all`) is already ~1.3 MB of commit messages and only grows, so
 * `execFileSync`'s 1 MB default made the documented `--all` mode throw
 * `ENOBUFS` instead of reporting. Capped rather than unbounded so a runaway
 * `git` still fails loudly instead of eating the machine.
 */
export const GIT_EXEC_OPTIONS = { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 } as const;

export interface IssueRef {
  number: number;
  /** True when a commit used a closing keyword rather than a bare reference. */
  closing: boolean;
}

/**
 * Extract issue references from a commit message.
 *
 * Distinguishes the two forms the repo actually uses, because they mean
 * different things: `Closes #12` is an action GitHub honours, `(#12)` in a
 * subject is a link that leaves the issue open forever.
 */
export function parseIssueRefs(message: string): IssueRef[] {
  const found = new Map<number, boolean>();

  for (const m of message.matchAll(
    /\b(clos(?:e|es|ed)|fix(?:es|ed)?|resolv(?:e|es|ed))\s+#(\d+)/gi,
  )) {
    found.set(Number(m[2]), true);
  }
  for (const m of message.matchAll(/#(\d+)/g)) {
    const n = Number(m[1]);
    if (!found.has(n)) found.set(n, false);
  }

  return [...found.entries()].map(([number, closing]) => ({ number, closing }));
}

/** Open issues referenced by a shipped commit — candidates for closing. */
export function shippedCandidates(
  openIssues: Array<{ number: number; title: string }>,
  commits: Array<{ sha: string; message: string }>,
): Array<{ number: number; title: string; commits: string[]; anyClosing: boolean }> {
  const open = new Map(openIssues.map((i) => [i.number, i.title]));
  const hits = new Map<number, { commits: string[]; anyClosing: boolean }>();

  for (const c of commits) {
    for (const ref of parseIssueRefs(c.message)) {
      if (!open.has(ref.number)) continue;
      const entry = hits.get(ref.number) ?? { commits: [], anyClosing: false };
      entry.commits.push(c.sha);
      entry.anyClosing ||= ref.closing;
      hits.set(ref.number, entry);
    }
  }

  return [...hits.entries()]
    .map(([number, v]) => ({ number, title: open.get(number)!, ...v }))
    .sort((a, b) => a.number - b.number);
}

function gitCommits(sinceRef: string | null): Array<{ sha: string; message: string }> {
  const range = sinceRef ? `${sinceRef}..HEAD` : 'HEAD';
  const out = execFileSync('git', ['log', range, '--format=%H%x1f%B%x1e'], GIT_EXEC_OPTIONS);
  return out
    .split('\x1e')
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, message] = rec.split('\x1f');
      return { sha: sha.slice(0, 8), message: message ?? '' };
    });
}

function lastReleaseTag(): string | null {
  try {
    return execFileSync(
      'git',
      ['describe', '--tags', '--abbrev=0', '--match', 'v*'],
      GIT_EXEC_OPTIONS,
    ).trim();
  } catch {
    return null;
  }
}

function openIssues(): Array<{ number: number; title: string }> | null {
  try {
    return JSON.parse(
      execFileSync(
        'gh',
        ['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title'],
        {
          encoding: 'utf8',
        },
      ),
    );
  } catch {
    return null;
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const issues = openIssues();
  if (!issues) {
    console.log('Needs an authenticated `gh` CLI to read the open-issue list — skipping.');
    return;
  }

  const since = argv.includes('--all') ? null : lastReleaseTag();
  const commits = gitCommits(since);
  const candidates = shippedCandidates(issues, commits);

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ since, scanned: commits.length, candidates }, null, 2));
    return;
  }

  const scope = since ? `since ${since}` : 'in the whole history';
  if (!candidates.length) {
    console.log(
      `No open issue is referenced by a shipped commit ${scope} (${commits.length} scanned).`,
    );
    return;
  }

  console.log(`Open issues referenced by a shipped commit ${scope} (${commits.length} scanned):\n`);
  for (const c of candidates) {
    // A closing keyword that did NOT close means the PR body lacked it and the
    // keyword only lived in a commit body — the exact #257 failure mode.
    const flag = c.anyClosing ? 'CLOSING KEYWORD, still open' : 'referenced';
    console.log(`  #${c.number} [${flag}] ${c.title}`);
    console.log(`      ${c.commits.join(', ')}`);
  }
  console.log(
    '\nCandidates only — a commit can reference an issue without resolving it.\n' +
      'Confirm, then close with a note on what shipped, or comment the remaining scope.',
  );
}

if (import.meta.main) main();

export interface ParsedChangelogItem {
  scope?: string;
  description: string;
  commitSha?: string;
  commitUrl?: string;
}

const SCOPE_RE = /^\*\*([^*:]+):\*\*\s*/;
const COMMIT_RE = /\(\[([^\]]+)\]\(([^)]+)\)\)\s*$/;

export function parseChangelogItem(raw: string): ParsedChangelogItem {
  let scope: string | undefined;
  let text = raw;

  const scopeMatch = text.match(SCOPE_RE);
  if (scopeMatch) {
    scope = scopeMatch[1];
    text = text.slice(scopeMatch[0].length);
  }

  const commitMatch = text.match(COMMIT_RE);
  if (commitMatch && commitMatch.index !== undefined) {
    return {
      scope,
      description: text.slice(0, commitMatch.index).trim(),
      commitSha: commitMatch[1],
      commitUrl: commitMatch[2],
    };
  }

  return { scope, description: text.trim() };
}

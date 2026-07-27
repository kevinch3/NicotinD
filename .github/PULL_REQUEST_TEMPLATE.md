<!--
Keep the "Closes/Refs" line below — it is the whole point of this template.

`Closes #123` in THIS BODY is an *action*: GitHub closes the issue when this
merges to the default branch.
`(#123)` in a commit subject is only a *reference*: it links, and the issue
stays open forever.

That distinction is why six issues were once found already-shipped but still
open (#257), and five more after that — the documentation gate held while the
tracker silently didn't.

For partial work, use `Refs #123` instead and say what's left, so the issue
keeps an accurate scope rather than overstating the remaining work.
-->

Closes #

## What

<!-- What changed, and why this approach. -->

## Verification

<!--
What you actually ran, with results — not what you intend to run.
Per CLAUDE.md's quality gates:
  - bun run test / test:web       (every change is tested)
  - bun run typecheck / lint
  - bun run e2e                   (before declaring a feature done)
Note any pre-existing failures you did NOT cause.
-->

## Docs

<!--
Gate 3: docs land in the SAME change as the code.
  - detail in docs/<feature>.md or docs/design-patterns.md
  - a one-line index entry in CLAUDE.md pointing at it
  - a `// why` comment for local rationale
If a change made an existing doc statement wrong, say which one you fixed.
-->

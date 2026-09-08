# Diagrams

Standalone, self-contained HTML diagrams. The `.json` is the source of truth and is tracked;
the rendered `.html` is a ~700 KB build output and is gitignored. Edit the JSON, then regenerate.

Regenerate (requires the [archify](https://github.com/tt-a1i/archify) skill):

```bash
node ~/.claude/skills/archify/bin/archify.mjs deliver architecture \
  docs/diagrams/nicotind-architecture.json docs/diagrams/nicotind-architecture.html \
  --quality showcase --repo-root .
```

Then confirm it actually fits on a desktop — `deliver` returning ok is not that evidence:

```bash
node ~/.claude/skills/archify/bin/archify.mjs visual-check docs/diagrams/nicotind-architecture.html
```

It writes screenshots and a receipt beside the HTML; both are gitignored.

`meta.repository.revision` pins the commit the `SRC` badges resolve against; bump it when the
referenced files move.

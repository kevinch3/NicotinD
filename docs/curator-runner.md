# Curator runner — unattended, scheduled curation with any model (issue #1516)

`packages/curator-runner` is a one-shot CLI that does one curation run against a NicotinD
library over MCP, then exits. A scheduler starts it: host cron, a systemd timer, GitHub Actions,
or anything else that can run a command. The model is pluggable: a quantized model on a
self-hosted Ollama, any OpenAI-compatible endpoint (llama.cpp server, vLLM, LM Studio, GitHub
Models, OpenRouter, Groq), or the Claude API.

It works the genre backlog only: songs with no genre and songs whose only genre is a catch-all
(`Electronic`, `Dance`). That is the backlog the [curation playbook](curation-playbook.md) works
by hand.

## Why it is safe on a cheap model

The design assumes the model is wrong some of the time. Four layers stand between a bad answer
and the library, and only the first depends on the model behaving.

1. **The model answers one question.** Code picks the worklist, the album, the songs, the tool
   and every argument. The model only fills `{genre, confidence, evidence}`. `genre` is an enum
   of the library's own vocabulary (`list_genre_vocabulary`) plus `unknown`, sent as a strict
   JSON schema, so a server with grammar-constrained decoding (Ollama, llama.cpp, vLLM) cannot
   emit an invented genre at all. `parseVerdict` treats anything off-schema as `unknown`.
2. **Self-consistency.** Each album is asked `CURATOR_SAMPLES` times (default 3) at a non-zero
   temperature (`decide`):
   - A write needs every sample to name the same genre with `high` confidence.
   - Mostly `unknown` means the album is left untagged, with no card, which is the skill's
     inconclusive-search rule.
   - Anything in between becomes a card.
3. **Propose by default.** `CURATOR_APPLY=propose` writes nothing. It files one review card per
   album, with an option per candidate genre (the `song-genre` card effect). A human taps one in
   the triage round. Switch to `auto` only after reading what a model proposes. Card choices are
   the measurement of how often it is right.
4. **The server is the policy.** The runner refuses to start unless its token has the
   `refiner:auto` scope, and that scope is policed in `dispatchTool`, not in a prompt (see
   [mcp-agent.md](mcp-agent.md) "Unattended tokens"):
   - only reads, `set_song_genre` and `flag_for_review`
   - `set_song_genre` only fills genre-less or catch-all-only songs, and only with vocabulary
     genres
   - a daily write budget
   - a token that always expires

   A model that tries anything else gets a refusal, not a write.

The runner also mirrors the server's fill-only rule when it builds a card (`isReplaceable`). A
card's tap is applied without that policy, so the card must not offer to overwrite a song that
has a real genre beside its catch-all. Every write in `auto` mode is read back from
`get_album_tracks` (`ok` is not proof, #760).

## What one run does

```
initialize (scope must be refiner:auto)
→ skip the run if an ingest is landing songs (ingestInProgress)
→ read genres.lowInformation / genres.missing         (get_library_health, dimensions: [genres])
→ loop:
    albums = every album of each catch-all-worklist artist
           + albums of the latest genre-less songs     (collectAlbumIds)
           − albums tried this run − albums in cooldown
    per album: load tracks + artist context → skip if no safe candidate song
               → k verdicts → decide → write / card / leave
    re-read the metrics
  until a stop condition
→ print the run report (markdown, curation-pass shape)
```

**The cluster is the album, not the artist.** A DJ mix or compilation filed under one artist
carries other artists' tracks. The 2026-10 pass found worklist rows whose artist label named
none of the songs (#1391). Artist context, meaning origin, MusicBrainz identity and the genres of
the artist's other albums, goes into the prompt as evidence.

Stop conditions (`StopReason`):

| Stop | When |
| --- | --- |
| `targets-met` | `CURATOR_TARGET_LOW_INFORMATION` / `CURATOR_TARGET_MISSING` reached (all set ones) |
| `worklist-exhausted` | no album left that is not in cooldown. In `auto` mode the worklist sample shifts as fixes land, so a run can go several rounds |
| `budget-exhausted` | the server refused a write for the token's daily budget |
| `max-clusters` / `time-limit` | `CURATOR_MAX_CLUSTERS` albums asked / `CURATOR_MAX_MINUTES` elapsed |
| `ingest-in-progress` | ≥5 distinct landings in the last 30 min: a genre-less song mid-ingest may be a partial |
| `model-unavailable` | 3 consecutive model failures |

**Attempt memory.** A runner-local SQLite file (`CURATOR_STATE_DB`) records each album it tried,
and the album then cools down for `CURATOR_COOLDOWN_DAYS` (30). A daily schedule does not re-ask
about the same unresolvable album every day. A dry run records nothing.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CURATOR_MCP_URL` | required | e.g. `http://nicotind:8484/api/mcp` |
| `CURATOR_MCP_TOKEN` | required | an **Unattended** token from Settings → Agent tokens |
| `CURATOR_MODEL_PROVIDER` | `openai` | `openai` (any OpenAI-compatible endpoint) or `anthropic` |
| `CURATOR_MODEL_BASE_URL` | `http://localhost:11434/v1` (Ollama) / `https://api.anthropic.com` | endpoint root |
| `CURATOR_MODEL` | required | model id, e.g. `qwen2.5:7b-instruct-q4_K_M`, `claude-haiku-5-5` |
| `CURATOR_MODEL_API_KEY` | none | required for `anthropic`; sent as a bearer token to OpenAI-compatible endpoints |
| `CURATOR_APPLY` | `propose` | `propose` (cards only) or `auto` (write unanimous high verdicts) |
| `CURATOR_SAMPLES` | `3` | verdicts per album (1–9) |
| `CURATOR_TEMPERATURE` | `0.4` | sampling temperature; non-zero so the samples can disagree |
| `CURATOR_MAX_CLUSTERS` | `20` | albums asked per run |
| `CURATOR_MAX_MINUTES` | `30` | wall-clock cap |
| `CURATOR_TARGET_LOW_INFORMATION` / `_MISSING` | none | stop once the metric is at or below |
| `CURATOR_STATE_DB` | `curator-state.sqlite` | attempt memory |
| `CURATOR_COOLDOWN_DAYS` | `30` | how long a tried album is skipped |
| `CURATOR_CARD_LANGUAGE` | `en` | `en` or `es`, the card question's language |

Flags: `--dry-run` asks the model and prints what would happen, without writing or recording
anything. `--report <file>` also writes the report to a file.

## Scheduling recipes

**Self-hosted with Docker (recommended).** The runner ships inside the nicotind image. The
`curator` compose profile runs it with its own entrypoint and keeps its state in the
`curator-state` volume. Put the token and model in `.env`, then add a host cron line, for example
Monday and Thursday at 04:30, after the 04:00 backup:

```cron
30 4 * * 1,4  cd /path/to/nicotind && docker compose --profile curator run --rm curator
```

On a host whose GPU is shared (the reference host runs Immich ML and the analysis sidecar on one
8 GB card), use a 3–4B model or a 7B at Q4. Night-time scheduling keeps it off the GPU while
other jobs are busy. Throughput is tens of decisions per run, so even CPU inference is enough.

**From source**: `CURATOR_MCP_URL=… CURATOR_MCP_TOKEN=… CURATOR_MODEL=… bun run
packages/curator-runner/src/main.ts --dry-run`.

**GitHub Actions** needs `/api/mcp` reachable from the runner (the public edge, or a Tailscale
step) and repository secrets. GitHub Models is OpenAI-compatible, so its token works as the model
key:

```yaml
on:
  schedule: [{ cron: '30 4 * * 1,4' }]
  workflow_dispatch:
permissions: { contents: read, models: read }
jobs:
  curate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
      - run: bun run packages/curator-runner/src/main.ts --report report.md
        env:
          CURATOR_MCP_URL: ${{ secrets.CURATOR_MCP_URL }}
          CURATOR_MCP_TOKEN: ${{ secrets.CURATOR_MCP_TOKEN }}
          CURATOR_MODEL_BASE_URL: https://models.github.ai/inference
          CURATOR_MODEL: openai/gpt-4.1-mini
          CURATOR_MODEL_API_KEY: ${{ secrets.GITHUB_TOKEN }}
          CURATOR_STATE_DB: /tmp/curator-state.sqlite
```

A CI runner keeps no state between runs, so either cache `CURATOR_STATE_DB` with
`actions/cache` or accept that cooldown does not apply.

## Not in scope (yet)

Merges, deletes, hunts (`complete_album`), genre aliases and MBIDs stay with a human or an
interactive session. The `refiner:auto` scope refuses all of them. The remaining phases of #1516
are:

- run records with revert
- deterministic no-model genre lanes
- a self-hosted search adapter (SearXNG)
- per-model precision measured from card choices, the evidence for switching a model to `auto`

## Tests

The tests live in `packages/curator-runner/src/*.test.ts`. `FakeMcp` (`testing.ts`) mirrors the
server's auto-scope policy for `set_song_genre`, so a test that asserts "the runner never writes
X" cannot pass because the fake is more permissive than production. They cover:

- the auto-only token gate
- propose and auto paths, with read-back
- disagreement and low confidence going to a card
- mostly-unknown going to no write and no card
- dry run, cooldown, the budget stop, the ingest skip, model failure and targets
- adapter contracts for both providers, including the JSON-schema fallback

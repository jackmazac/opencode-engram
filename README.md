# Engram

OpenCode plugin that stores a **project memory** sidecar (`memory.db`): FTS5 full-text search, embedding blobs, streaming cosine retrieval, RRF merge, optional LLM rerank, telemetry, eval reports, archive maintenance, and curation workflows. It captures session text and tool traces, exposes **`memory`**, **`forget`**, **`memory_feedback`**, and **`stats`** tools, can inject **`<project_memory>`** and a light **`<engram-hint>`** for root sessions (same `experimental.chat.system.transform` hook family as [DCP](https://github.com/Tarquinen/opencode-dynamic-context-pruning)), and ships a small **`engram`** CLI for eval, dashboard, archive, curation, and maintenance work.

**Repository:** [github.com/jackmazac/opencode-engram](https://github.com/jackmazac/opencode-engram)

## Requirements

- [Bun](https://bun.sh) (runtime and tests)
- An **OpenAI API key** (or compatible usage) for embeddings, classification batches, and rerank when enabled

## Install (OpenCode)

Use a **`file://`** URL to the plugin entry (OpenCode imports it directly; no publish step required):

```json
{
  "plugin": ["file:///Users/you/Developer/engram/src/index.ts"]
}
```

Adjust the path to your clone. Restart OpenCode after changing `plugin`.

Per **worktree**, optional overrides live in **`.opencode/engram.jsonc`** (or `engram.json`), merged on top of built-in defaults. The schema is defined in [`src/config.ts`](src/config.ts) (`defaultEngramConfig`).

Engram is standalone. Optional integration profiles can ingest generic OpenCode artifacts, but Engram does not require the Conductor/Orchestrator setup.

## API key

Resolution order (see [`src/openai.ts`](src/openai.ts)):

1. `openaiApiKey` in `engram.jsonc`
2. Environment variable **`OPENAI_API_KEY`**
3. **macOS Keychain** — generic password: service **`OPENAI_KEYCHAIN_SERVICE`** (default `OPENAI_API_KEY`), optional account **`OPENAI_KEYCHAIN_ACCOUNT`**

Example Keychain item:

```bash
security add-generic-password -s OPENAI_API_KEY -a default -w "sk-..."
```

## Orchestrator hint

With **`hints.orchestrator`** `true` (default), Engram appends a short **`<!-- Engram --><engram-hint>…`** block to the **last** entry of `system[]` on `experimental.chat.system.transform`, matching how DCP extends the system prompt. It runs only when **`session.get`** shows **no `parentID`** (skip task / child sessions). Utility prompts (title generator, conversation summarizer, etc.) are skipped. Turn off with `"hints": { "orchestrator": false }`. This is separate from **`proactive`** `<project_memory>` (which still needs an API key).

## Tools

| Tool              | Purpose                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `memory`          | Search memory (FTS + streaming vector scan + merge; optional rerank). |
| `memory_feedback` | Mark retrieved chunks useful/not useful so future ranking can adapt.  |
| `forget`          | Drop chunks matching a pattern / scope (see config limits).           |
| `stats`           | Sidecar stats, telemetry summaries, and embedding health.             |

## CLI (`engram`)

From a clone of this repo:

```bash
bun install
export ENGRAM_PROJECT_ID=<uuid-from-opencode-project-table>
# optional: --project-id <uuid>

bun run ./src/cli/run.ts archive list --worktree /path/to/project
bun run ./src/cli/run.ts archive export <rootSessionId> [--force] --worktree /path/to/project
bun run ./src/cli/run.ts archive export-stale [--all] --worktree /path/to/project
bun run ./src/cli/run.ts archive verify <rootSessionId> --worktree /path/to/project
bun run ./src/cli/run.ts archive verify-all --worktree /path/to/project
bun run ./src/cli/run.ts archive inspect <rootSessionId> --worktree /path/to/project
bun run ./src/cli/run.ts archive search <rootSessionId> "query" --worktree /path/to/project
bun run ./src/cli/run.ts archive restore [--apply] <rootSessionId> --worktree /path/to/project
bun run ./src/cli/run.ts archive import-memory <rootSessionId> --worktree /path/to/project
bun run ./src/cli/run.ts archive delete [--vacuum] <rootSessionId> ... --worktree /path/to/project
bun run ./src/cli/run.ts ingest-artifacts [--apply] --project-id <uuid> --worktree /path/to/project
bun run ./src/cli/run.ts index-hot [--apply] --project-id <uuid> --worktree /path/to/project
bun run ./src/cli/run.ts backfill-hot [--apply] [--strategy priority] --project-id <uuid> --worktree /path/to/project
bun run ./src/cli/run.ts distill [--apply] [--top 20] --project-id <uuid> --worktree /path/to/project
bun run ./src/cli/run.ts relations [--apply] --project-id <uuid> --worktree /path/to/project
bun run ./src/cli/run.ts context "query" --project-id <uuid> --worktree /path/to/project
bun run ./src/cli/run.ts eval run --fixture eval/fixtures/core.json --worktree /path/to/project
bun run ./src/cli/run.ts dashboard [--json] --project-id <uuid> --worktree /path/to/project
bun run ./src/cli/run.ts maintain [--apply] [--health-report] --project-id <uuid> --worktree /path/to/project
bun run ./src/cli/run.ts curate [--apply] --project-id <uuid> --worktree /path/to/project
bun run ./src/cli/run.ts telemetry --project-id <uuid> --worktree /path/to/project
bun run ./src/cli/run.ts sprint [--rows 3000] [--local-only] [--rerank] --worktree /path/to/project
```

`archive delete` verifies every requested archive before touching the hot DB. `archive restore` is dry-run by default; pass `--apply` only after testing on a copy of `opencode.db`.

`ingest-artifacts`, `index-hot`, `backfill-hot`, `distill`, `relations`, and `context` are the long-term learning pipeline. They discover high-signal OpenCode artifacts, index root session trees, selectively backfill useful hot DB evidence, create deterministic root summaries, connect superseded memories, and produce bounded preflight context bundles. Mutating commands are dry-run by default and require `--apply`.

Automatic hot DB backfill is **off by default** (`backfill.auto: false`) so plugin startup never scans large OpenCode databases. Use `backfill-hot` for explicit learning runs, or opt into scheduled legacy backfill with `backfill.auto: true` plus `backfill.startupDelayMs`/`backfill.intervalMs`.

`eval` runs checked-in retrieval fixtures and records drift metadata. `dashboard` is CLI/JSON-only and summarizes memory health, archives, evals, telemetry, and learning coverage. `maintain` performs dry-run or explicit maintenance actions. `curate` proposes duplicate/low-value chunk cleanup and only mutates with `--apply`. `telemetry` summarizes sidecar operation metrics recorded by live plugin usage. `sprint` runs a manual latency/memory sprint: a deterministic local retrieval workload plus, when an OpenAI key resolves, a small live embedding retrieval accuracy fixture.

The [`package.json`](package.json) `"bin"` field exposes the same entry as the `engram` command if you `bun link` or install the package locally.

## Verify it is working

1. Load the plugin via `file://`, open a project, send an assistant turn.
2. Check **`.opencode/memory.db`** for `chunk` / `chunk_fts` rows.
3. Invoke **`memory`** from an agent and confirm hits / `retrieval_log`.
4. Run `bun run ./src/cli/run.ts eval run --fixture eval/fixtures/core.json --worktree .` and confirm a 100% core fixture report.
5. Run `bun run ./src/cli/run.ts dashboard --project-id engram-eval-core --worktree .` after eval and confirm the latest eval appears.
6. With **`proactive.enabled`**, confirm `<project_memory>` appears on normal chat sessions that carry a `sessionID` (paths without a session skip injection).

## Development

Run from **this directory** (not a monorepo root):

```bash
bun install
bun run typecheck
bun test --timeout 30000
```

Tests include an **optional live** suite (`test/openai-live-nano.test.ts`) when a key resolves via env or Keychain. Performance checks use a real in-memory SQLite path in `test/perf-operations.test.ts`.

## Eval and manual testing

- Checked-in retrieval fixtures live in [`eval/fixtures`](eval/fixtures).
- `engram eval run` reports recall@K, hit@K, MRR, p50, and p95 latency.
- `engram ingest-artifacts` should run before broad hot DB backfills; plans, audits, journals, and progress files are higher signal than raw tool output.
- `engram context` is the CLI/TUI-friendly Orchestrator bridge: it returns a bounded preflight bundle without requiring the custom Orchestrator plugin.
- The bridge contract is exported from `opencode-engram/bridge` for optional integrations.
- `engram sprint` measures local FTS/vector latency and can run a small live retrieval fixture.
- See [`docs/manual-testing.md`](docs/manual-testing.md) for the current sprint checklist.

## Local OpenCode install notes

This repo is intended to load via a direct `file://` plugin entry during local development. See [`docs/opencode-install.md`](docs/opencode-install.md) for the current global config and prompt integration checklist.

## Performance (expectations)

- Capture enqueue is designed to stay lightweight on typical dev hardware.
- Vector search intentionally remains the canonical streaming brute-force implementation for now. There is no sqlite-vec fallback path; a vector index should only replace the canonical backend after eval/telemetry prove it is necessary.
- Archive export throughput depends on `archive.batchSize` and DB size; ballpark on the order of seconds per thousand messages is normal.

## License

MIT

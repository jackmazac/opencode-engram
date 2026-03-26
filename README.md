# @opencode-ai/engram

OpenCode plugin: sidecar `memory.db` (FTS5 + embedding blobs + cosine retrieval), capture from session events, `memory` / `forget` / `stats` tools, optional proactive `<project_memory>` injection, background archive export, and a standalone CLI for archive maintenance.

## Config

`.opencode/engram.jsonc` in the **worktree** (merged over built-in defaults). See your `OVERVIEW.md` in the Engram plugin docs for the full field list.

- **OpenAI**: `OPENAI_API_KEY` or `openaiApiKey` in config.
- **Hot DB** (archive / backfill): defaults to OpenCode data dir + `opencode.db`; override with `archive.hotDbPath`.

## CLI (`engram`)

From this repo: `bunx` / `bun run ./src/cli/run.ts`, or link the `engram` bin from `package.json`.

```bash
export ENGRAM_PROJECT_ID=<uuid-from-opencode-project-table>
# or pass --project-id <uuid>

engram archive list --worktree /path/to/project
engram archive export <rootSessionId> [--force] --worktree /path/to/project
engram archive export-stale --worktree /path/to/project
engram archive verify <rootSessionId> --worktree /path/to/project
engram archive delete [--vacuum] <rootSessionId> ... --worktree /path/to/project
```

`archive delete` requires a passing `verify` first. Use a **copy** of production `opencode.db` until you trust the workflow.

## Manual validation

1. Point OpenCode `plugin` at this package’s built entry (or `src/index.ts` via `file://`).
2. Send an assistant turn; confirm rows in `.opencode/memory.db` (`chunk` / `chunk_fts`).
3. Call `memory` from an agent; confirm citations and `retrieval_log`.
4. Confirm `<project_memory>` in the system path when `proactive.enabled` is true (normal chat with `sessionID` only; Agent.generate has no `sessionID` and skips injection).
5. Run `engram archive export` on a DB copy; gunzip JSONL; run `verify`.

## Performance targets (informative)

- Capture enqueue should stay well under ~10 ms wall on typical dev hardware.
- Archive export: on the order of ~5 s per 1000 messages (batched RO connections, configurable `archive.batchSize`).

Run checks from this directory only:

```bash
bun typecheck
bun test
```

# Manual Testing

Run these checks after feature work that changes retrieval, archive, telemetry, eval, curation, or install wiring.

## Baseline

```bash
bun run typecheck
bun test --timeout 30000
bun run ./src/cli/run.ts sprint --local-only --rows 3000 --worktree .
```

## Retrieval Eval

```bash
bun run ./src/cli/run.ts eval run --fixture eval/fixtures/core.json --out /tmp/engram-eval-core --worktree .
```

Expected current baseline for `core`: recall@3 100%, hit@3 100%, MRR 1.

## Dashboard And Maintenance

```bash
bun run ./src/cli/run.ts dashboard --project-id engram-eval-core --worktree .
bun run ./src/cli/run.ts dashboard --json --project-id engram-eval-core --worktree .
bun run ./src/cli/run.ts telemetry --events --project-id engram-eval-core --worktree .
bun run ./src/cli/run.ts maintain --project-id engram-eval-core --worktree .
```

`maintain` is dry-run by default. Use `--apply` only when the target DB is safe to mutate.

## Learning Pipeline

Run the pipeline in this order. Use dry-runs first on real projects.

```bash
bun run ./src/cli/run.ts ingest-artifacts --project-id <projectId> --worktree /path/to/project
bun run ./src/cli/run.ts ingest-artifacts --apply --project-id <projectId> --worktree /path/to/project

bun run ./src/cli/run.ts index-hot --project-id <projectId> --worktree /path/to/project
bun run ./src/cli/run.ts index-hot --apply --project-id <projectId> --worktree /path/to/project

bun run ./src/cli/run.ts backfill-hot --strategy priority --max-roots 10 --max-parts 1000 --project-id <projectId> --worktree /path/to/project
bun run ./src/cli/run.ts backfill-hot --apply --strategy priority --max-roots 10 --max-parts 1000 --project-id <projectId> --worktree /path/to/project

bun run ./src/cli/run.ts distill --top 20 --project-id <projectId> --worktree /path/to/project
bun run ./src/cli/run.ts distill --apply --top 20 --project-id <projectId> --worktree /path/to/project

bun run ./src/cli/run.ts relations --max 200 --project-id <projectId> --worktree /path/to/project
bun run ./src/cli/run.ts relations --apply --max 200 --project-id <projectId> --worktree /path/to/project

bun run ./src/cli/run.ts context "planning query" --limit 12 --project-id <projectId> --worktree /path/to/project
```

The preferred source order is artifacts first, root index second, prioritized hot DB evidence third, distillation fourth, relation/supersession fifth.

## Motif Smoke

For the local Motif workspace:

```bash
PROJECT=7bc5e857ac92adfe3c30f26082cb9326e0bcd927
WT=/Users/jack.mazac/Developer/execintel

bun run ./src/cli/run.ts dashboard --project-id "$PROJECT" --worktree "$WT"
bun run ./src/cli/run.ts telemetry --events --level warn --project-id "$PROJECT" --worktree "$WT"
bun run ./src/cli/run.ts context "brief persistence auto update background tasks workspace" --limit 12 --project-id "$PROJECT" --worktree "$WT"
bun run ./src/cli/run.ts maintain --project-id "$PROJECT" --worktree "$WT"
```

## Archive Safety

Archive restore writes to the OpenCode hot DB, so first test against a copied hot DB configured through `.opencode/engram.jsonc` `archive.hotDbPath`.

```bash
bun run ./src/cli/run.ts archive inspect <rootSessionId> --project-id <projectId> --worktree /path/to/project
bun run ./src/cli/run.ts archive search <rootSessionId> "query" --project-id <projectId> --worktree /path/to/project
bun run ./src/cli/run.ts archive restore <rootSessionId> --project-id <projectId> --worktree /path/to/project
```

Only then run:

```bash
bun run ./src/cli/run.ts archive restore --apply <rootSessionId> --project-id <projectId> --worktree /path/to/project
```

## Live Retrieval

When an OpenAI key resolves:

```bash
bun run ./src/cli/run.ts sprint --rows 3000 --worktree .
```

This runs deterministic local latency plus a small live retrieval accuracy fixture.

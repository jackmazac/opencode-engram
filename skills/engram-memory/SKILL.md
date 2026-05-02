---
name: engram-memory
description: Use Engram project memory effectively: compile preflight context, search prior decisions, give feedback, and inspect memory health.
license: MIT
compatibility:
  opencode: ">=1.0.0"
metadata:
  plugin: opencode-engram
  tools:
    - memory_context
    - memory
    - memory_feedback
    - stats
---

# Engram Memory

Use this skill when working in a project that has the Engram OpenCode plugin installed. Engram turns prior plans, audits, decisions, reviews, root-session summaries, telemetry, and selected chat history into local project memory.

## Core Rule

For non-trivial project work, compile context before acting.

Use `memory_context` first for planning, implementation, review, debugging, audits, and handoffs. Use `memory` only when you need a precise lookup or more raw evidence.

Skip Engram for tiny one-off edits where prior project context is unlikely to matter.

## Tool Choice

| Need                                           | Tool              |
| ---------------------------------------------- | ----------------- |
| Preflight context for a task                   | `memory_context`  |
| Specific past decision or detail               | `memory`          |
| Mark a retrieved memory useful or stale        | `memory_feedback` |
| Check memory health, telemetry, or eval status | `stats`           |

## Context Modes

Choose the mode based on what you are about to do.

| Mode        | Use Before                          | Prioritizes                                                 |
| ----------- | ----------------------------------- | ----------------------------------------------------------- |
| `plan`      | Planning or decomposing work        | decisions, contracts, requirements, audits, risks           |
| `implement` | Editing code                        | API contracts, prior fixes, migrations, successful patterns |
| `review`    | Reviewing changes                   | invariants, reviewer findings, bugs, test strategy          |
| `debug`     | Diagnosing failures                 | errors, failed commands, root-cause fixes, perf notes       |
| `audit`     | Broad audits                        | prior audits, coverage gaps, product requirements, risks    |
| `handoff`   | Summaries, scribe, session transfer | latest plans, progress, journal entries, distillations      |

Example tool calls:

```text
memory_context({ query: "brief persistence auto update", mode: "plan", limit: 12 })
memory_context({ query: "workspace tree artifact path contract", mode: "implement", limit: 12 })
memory_context({ query: "network latency transport timeout", mode: "debug", limit: 12 })
```

## How To Read Context Bundles

Engram context bundles are sectioned. Treat sections differently.

| Section                | How To Use It                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| Must Know              | Decisions, contracts, and invariants. Do not contradict these without explicit user approval.    |
| Current Risks          | Known bugs, audit findings, failure modes, and review concerns. Account for these in the plan.   |
| Relevant Past Work     | Similar plans, audits, root sessions, and distillations. Reuse lessons and avoid repeating work. |
| Prior Successful Paths | Migrations, test strategies, prior fixes, and validated implementation patterns.                 |
| Evidence               | Supporting memories and source IDs. Use for verification, citations, and deeper lookup.          |
| Suggested Next Steps   | Rule-based suggestions. Treat as guidance, not a substitute for judgment.                        |

Every item includes `why:` reasons. Prefer high-authority artifact-backed memories over raw chat snippets or tool traces.

## Planning Workflow

Before drafting a plan for meaningful work:

1. Call `memory_context` with `mode: "plan"` and a short task description.
2. Incorporate `Must Know` and `Current Risks` into the plan.
3. Reuse relevant previous plans/audits where appropriate.
4. If context is missing or stale, note that uncertainty instead of inventing history.

## Implementation Workflow

Before editing code in a known domain:

1. Call `memory_context` with `mode: "implement"`.
2. Check API contracts, invariants, migration notes, and prior successful paths.
3. Keep changes aligned with high-authority memory unless the user directs otherwise.
4. Use `memory` for exact evidence when a bundle item is too brief.

## Review Workflow

Before reviewing changes:

1. Call `memory_context` with `mode: "review"`.
2. Compare the diff against prior invariants, known bugs, reviewer findings, and test strategy.
3. Flag regressions against high-authority memory as findings.
4. If a memory helped, call `memory_feedback` with `rating: "up"`.

## Debug Workflow

When debugging:

1. Call `memory_context` with `mode: "debug"` using the error or symptom.
2. Look for prior root-cause fixes, failed commands, perf notes, and similar bugs.
3. If nothing relevant appears, use `memory` with narrower terms.
4. After resolving, ensure durable conclusions are captured via normal project artifacts or summary.

## Feedback

Use feedback sparingly but consistently.

Call `memory_feedback` when:

- A memory directly helped the task.
- A memory was stale, misleading, or irrelevant.
- A high-authority context item should be reinforced or demoted.

Example:

```text
memory_feedback({ chunk_id: "01...", rating: "up", note: "Correct API contract for workspace tree implementation" })
```

## Health Checks

Use `stats` when memory behavior seems off.

| Check                | Tool Call                        |
| -------------------- | -------------------------------- |
| General state        | `stats({ report: "overview" })`  |
| Telemetry and events | `stats({ report: "telemetry" })` |
| Cached insights      | `stats({ report: "insights" })`  |

If Engram context returns little or nothing, likely causes are missing artifact ingest, missing root index, embedding backlog, or an overly narrow query.

## Quality Bar

Good Engram usage should produce:

- Shorter plans with fewer repeated discoveries.
- Fewer contradictions of prior decisions/contracts.
- More accurate reviews because invariants are available.
- Faster debugging by reusing past root-cause fixes.
- Better handoffs because agents can see durable project memory.

## Guardrails

- Do not treat low-authority raw tool traces as canonical.
- Do not override high-authority decisions/contracts without user approval.
- Do not add sqlite-vec, fallback vector backends, or memory architecture changes unless the user explicitly approves them and eval/telemetry justify the work.
- Do not dump large context bundles into prompts; ask for focused context with an appropriate mode and limit.
- Do not use Engram as a substitute for reading current code when code truth is required.

## CLI For Manual Validation

When working directly in a shell, useful checks include:

```bash
engram context "task description" --mode plan --project-id <id> --worktree <dir>
engram eval context --fixture eval/fixtures/context-core.json --worktree <dir>
engram dashboard --project-id <id> --worktree <dir>
engram telemetry --events --project-id <id> --worktree <dir>
```

Use sidecar-backed evals only when fixture expected IDs already exist in the project `memory.db`.

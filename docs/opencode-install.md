# Local OpenCode Install

Target config directory: `/Users/jack.mazac/.config/opencode`.

## Plugin Entry

Add Engram to `opencode.json` as a file plugin:

```json
"plugin": [
  "@nick-vi/opencode-type-inject",
  "@tarquinen/opencode-dcp@latest",
  "@franlol/opencode-md-table-formatter@latest",
  "@mohak34/opencode-notifier@latest",
  "file:///Users/jack.mazac/Developer/engram/src/index.ts"
]
```

The direct file entry keeps dependencies owned by the Engram repo. Do not add sqlite-vec; vector scan remains canonical until eval/telemetry justify a replacement.

## Prompt Updates

Update global prompts with short guidance:

- `prompts/orchestrator.txt`: use `memory` before large/repeated project work; use `stats telemetry`, `engram eval`, and dashboard for Engram health.
- `prompts/planner.txt`: include eval/telemetry checks in Engram-sensitive plans.
- `prompts/reviewer.txt`: review eval reports and telemetry for Engram changes.
- `prompts/scribe.txt`: preserve durable Engram decisions and update eval fixtures when memory patterns change.

## Validation

After editing config and prompts:

```bash
cd /Users/jack.mazac/Developer/engram
bun run typecheck
bun test --timeout 30000
bun run ./src/cli/run.ts eval run --fixture eval/fixtures/core.json --worktree .
```

Restart OpenCode, then confirm the `memory`, `memory_context`, `memory_feedback`, `forget`, and `stats` tools are available.

The optional bridge tool `memory_context` should also be available. It returns bounded preflight context from Engram without requiring the custom Orchestrator plugin.

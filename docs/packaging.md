# Packaging

## Engram

Package name: `opencode-engram`.

Repository: `https://github.com/jackmazac/opencode-engram`.

Exports:

- `opencode-engram` — OpenCode plugin entry.
- `opencode-engram/cli` — CLI entry.
- `opencode-engram/bridge` — optional bridge schemas and types.

## Conductor

Local scaffold: `/Users/jack.mazac/Developer/opencode-conductor`.

Recommended package name: `opencode-conductor`.

Conductor should own agent prompts, delegation workflow, artifact tools, and review/scribe conventions. Engram should remain a separate package that Conductor can optionally call through `memory_context` and artifact files.

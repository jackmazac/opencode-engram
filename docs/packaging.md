# Packaging

## Engram

Package name: `opencode-engram`.

Repository: `https://github.com/jackmazac/opencode-engram`.

Exports:

- `opencode-engram` — OpenCode plugin entry.
- `opencode-engram/cli` — CLI entry.
- `opencode-engram/bridge` — optional bridge schemas and types.
- `skills/engram-memory/SKILL.md` — optional OpenCode agent skill that teaches agents how to use Engram effectively.

Operational logs are intentionally stored in the sidecar as bounded `log_event` rows. Use `engram telemetry --events` or `engram dashboard --json` rather than depending on the table shape from companion packages.

Install the skill globally by copying `skills/engram-memory/SKILL.md` to `~/.config/opencode/skills/engram-memory/SKILL.md`, or project-locally by copying it to `.opencode/skills/engram-memory/SKILL.md`.

Eval fixtures support two modes:

- Synthetic fixtures seed their own chunks and run without `--sidecar`.
- Live fixtures run with `--sidecar` and assert IDs already present in a project's `memory.db`.

Prefer sidecar-backed context evals for package confidence on real projects, and keep private project-specific fixtures under that project's `.opencode/engram-eval/` directory rather than publishing them with the package.

## Conductor

Local scaffold: `/Users/jack.mazac/Developer/opencode-conductor`.

Recommended package name: `opencode-conductor`.

Conductor should own agent prompts, delegation workflow, artifact tools, and review/scribe conventions. Engram should remain a separate package that Conductor can optionally call through `memory_context` and artifact files.

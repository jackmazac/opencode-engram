# Bridge Contract

Engram and Conductor/Orchestrator are separate plugins. They integrate through stable artifact and context shapes rather than prompt-file coupling.

## Export

```ts
import { bridgeArtifactSchema, contextBundleRequestSchema } from "opencode-engram/bridge"
```

## Principles

- Engram must run without Conductor.
- Conductor must run without Engram.
- Artifact producers should emit generic `plan`, `audit`, `journal`, `review`, and `wave_progress` records.
- Engram consumes those records through artifact ingestion and exposes bounded context through `memory_context` or `engram context`.
- No integration should depend on `/Users/jack.mazac/.config/opencode/prompts`.

## Product Boundary

- Engram remembers, evaluates, ranks, curates, and reports.
- Conductor plans, delegates, reviews, and documents.
- Together they provide long-term engineering memory for disciplined multi-agent OpenCode work.

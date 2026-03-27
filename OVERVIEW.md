# Engram — Persistent Memory for OpenCode Agents

**Engram** is an OpenCode plugin that gives agents durable, searchable, cross-session memory. It captures high-signal assistant reasoning as sessions run, indexes it with embeddings and full-text search, and exposes a single `memory` tool that agents call to retrieve relevant past context. It also provides a session archival pipeline to move cold data out of the hot `opencode.db`, reclaiming disk and keeping queries fast.

The name: an engram is a hypothesized physical trace that memory leaves in the brain. This plugin is the trace your agent sessions leave behind.

---

## Problem Statement

OpenCode's `opencode.db` grows without bound. In production use (execintel project: ~6.3k sessions, ~187k messages, ~901k parts, ~12.7 GiB on disk), certain queries timeout. The `storage/` filesystem mirror adds another ~9.6 GiB. Meanwhile, agents are stateless across sessions — the orchestrator writes rich plans, decisions, and synthesis, but none of it is queryable from a future session beyond what fits in a handoff document or journal file.

Engram solves both problems: it builds a fast, small sidecar index of what matters (assistant reasoning, decisions, patterns) while providing tools to archive and evict what doesn't need to stay in the hot path.

---

## Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Runtime | Bun (inherited from OpenCode plugin host) | Plugins execute in the Bun process; native SQLite access via `bun:sqlite` |
| Sidecar DB | SQLite with FTS5 + `sqlite-vec` extension | Same stack as OpenCode core; single-file backup; WAL mode for concurrent reads |
| Embeddings | OpenAI `text-embedding-3-small` (1536-dim, configurable down to 256-dim via API) | $0.02/M tokens; mature, fast; dimension reduction available for storage/speed tradeoff |
| Reranker | OpenAI `gpt-5.4-nano` | $0.20/M input, $1.25/M output; 400k context; purpose-built for classification/ranking; sub-second latency |
| Archive format | Compressed JSONL (gzip) | Self-contained, streamable, git-friendly; one file per root session tree |
| Archive destination | Local `~/.opencode/archives/` (sync to GDrive/S3 externally) | Decouples archive pipeline from upload; works offline |

### Why `text-embedding-3-small` at 256 dimensions

The OpenAI embedding API supports a `dimensions` parameter that truncates embeddings with minimal quality loss. At 256-dim (vs default 1536), each vector is 1 KiB instead of 6 KiB. For 50k chunks, that's ~50 MiB vs ~300 MiB of vector storage. The quality tradeoff is small for our use case (retrieving from a single project's history, not a global corpus). Engram defaults to 256-dim and exposes a config override.

### Why `gpt-5.4-nano` for reranking

The reranker needs to read 20-30 candidate passages and rank them by relevance to a query. It doesn't need deep reasoning — it needs fast, cheap cross-attention. Nano's 400k context window fits all candidates easily, its classification/ranking benchmarks are strong, and at $0.20/M input it's 12.5x cheaper than GPT-5.4-mini. A typical rerank call (~8k tokens in, ~500 tokens out) costs ~$0.002.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    OpenCode Process                      │
│                                                          │
│  ┌──────────┐  events   ┌──────────────────────────┐    │
│  │ Sessions  │─────────▸│     Engram Plugin         │    │
│  │ Messages  │          │                            │    │
│  │ Parts     │          │  ┌─────────┐ ┌──────────┐ │    │
│  └──────────┘          │  │ Capture │ │  Tools   │ │    │
│       │                 │  │ Engine  │ │          │ │    │
│       │                 │  └────┬────┘ │ memory   │ │    │
│       ▼                 │       │      │ forget   │ │    │
│  opencode.db            │       ▼      │ stats    │ │    │
│  (HOT — shrinks)        │  ┌─────────┐ └────┬─────┘ │    │
│                         │  │ Sidecar │◀─────┘      │    │
│                         │  │ memory  │              │    │
│                         │  │  .db    │              │    │
│                         │  └────┬────┘              │    │
│                         │       │                    │    │
│                         │       ▼                    │    │
│                         │  ┌──────────┐              │    │
│                         │  │ Embed    │              │    │
│                         │  │ Queue    │──▸ OpenAI API│    │
│                         │  └──────────┘              │    │
│                         └──────────────────────────┘    │
│                                                          │
│  ~/.opencode/archives/   ◀── background export writes here│
└─────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Capture**: The `event` hook listens for `message.updated` and `message.part.updated` events. When an assistant message or part arrives, the capture engine extracts content, assigns a provisional `content_type` based on agent role, and writes a distilled record to `memory.db`. This is synchronous-fast (microseconds) and never blocks agents.

2. **Embed + Classify**: New chunks are added to a bounded in-process queue. A background loop drains the queue in batches (up to 100 chunks per API call). For each batch, it: (a) checks the content-hash embedding cache and skips already-embedded hashes, (b) calls `text-embedding-3-small` for uncached chunks, (c) piggybacks a `gpt-5.4-nano` classification call to refine provisional content types. If the API is unavailable, chunks stay unembedded/unclassified and retry on next drain.

3. **Inject**: On session start, the `experimental.chat.system.transform` hook runs a lightweight memory query against the session's handoff doc or first message, injecting a `<project_memory>` block into the system prompt. This gives agents historical context without requiring an explicit tool call.

4. **Query**: When an agent calls the `memory` tool, the pipeline runs: FTS5 pre-filter → vector recall (top 30) → RRF merge → `gpt-5.4-nano` rerank (top N) → return formatted results with citations. The query and results are logged to `retrieval_log` for the feedback loop.

5. **Archive (background)**: On `session.idle`, Engram automatically exports stale root session trees from `opencode.db` as compressed JSONL, backfills missing sidecar content, and records archive manifests. Deletion of archived rows is a human-operated CLI command, not an agent action.

---

## Sidecar Schema: `memory.db`

```sql
-- Core content table
CREATE TABLE chunk (
  id            TEXT PRIMARY KEY,     -- ULID
  session_id    TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  part_id       TEXT,                 -- NULL for message-level chunks
  project_id    TEXT NOT NULL,
  role          TEXT NOT NULL,        -- 'assistant' | 'user'
  agent         TEXT,                 -- 'orchestrator', 'planner', 'executor-high', ...
  model         TEXT,                 -- 'anthropic.claude-opus-4-6-v1-1m', 'gpt-5.4', ...
  content_type  TEXT NOT NULL,        -- 'synthesis' | 'analysis' | 'decision' | 'discovery'
                                      -- | 'reasoning' | 'plan' | 'contract' | 'error'
                                      -- | 'tool_trace' | 'milestone'
  content       TEXT NOT NULL,        -- the actual text (full for assistant, truncated for tools)
  file_paths    TEXT,                 -- JSON array of file paths touched/referenced
  tool_name     TEXT,                 -- for tool_trace type only
  tool_status   TEXT,                 -- 'completed' | 'error' | 'timeout'
  output_head   TEXT,                 -- first N chars of tool output
  output_tail   TEXT,                 -- last N chars of tool output
  output_length INTEGER,              -- total byte length of original output
  error_class   TEXT,                 -- classified error type if applicable
  embedding     BLOB,                 -- float32 vector (256-dim = 1024 bytes)
  time_created  INTEGER NOT NULL,     -- unix ms
  time_embedded INTEGER,              -- NULL until embedded
  content_hash  TEXT NOT NULL,        -- SHA-256 of normalized content (dedup + embedding cache)
  root_session_id TEXT,               -- root of the session tree (for lineage tracking)
  session_depth INTEGER,              -- depth in session tree (0 = root, 1 = direct child, etc.)
  plan_slug     TEXT                  -- active plan slug at capture time (if any)
);

-- Full-text search
CREATE VIRTUAL TABLE chunk_fts USING fts5(
  content, file_paths, tool_name, agent, content_type,
  content='chunk', content_rowid='rowid'
);

-- Vector similarity (sqlite-vec extension)
CREATE VIRTUAL TABLE chunk_vec USING vec0(
  embedding float[256]
);

-- Archive manifest
CREATE TABLE archive (
  id              TEXT PRIMARY KEY,   -- ULID
  root_session_id TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  session_count   INTEGER NOT NULL,
  message_count   INTEGER NOT NULL,
  part_count      INTEGER NOT NULL,
  archive_path    TEXT NOT NULL,      -- relative to ~/.opencode/archives/
  archive_size    INTEGER NOT NULL,   -- bytes
  content_hash    TEXT NOT NULL,      -- SHA-256 of archive file
  time_created    INTEGER NOT NULL
);

-- Type proposals (evolving classification schema)
CREATE TABLE type_proposal (
  id            TEXT PRIMARY KEY,     -- ULID
  proposed_type TEXT NOT NULL,        -- the type nano suggested
  chunk_id      TEXT NOT NULL REFERENCES chunk(id),
  confidence    REAL,                 -- nano's confidence score
  time_created  INTEGER NOT NULL
);

-- Retrieval feedback (learning loop)
CREATE TABLE retrieval_log (
  id            TEXT PRIMARY KEY,     -- ULID
  session_id    TEXT NOT NULL,        -- session that made the query
  query         TEXT NOT NULL,        -- the natural language query
  returned_ids  TEXT NOT NULL,        -- JSON array of chunk IDs returned
  referenced_ids TEXT,                -- JSON array of chunk IDs the agent actually used (filled post-hoc)
  time_created  INTEGER NOT NULL
);

-- Friction cache (insights report)
CREATE TABLE friction_cache (
  id            TEXT PRIMARY KEY,
  report        TEXT NOT NULL,        -- the generated insights report text
  chunk_window  TEXT NOT NULL,        -- date range analyzed
  time_created  INTEGER NOT NULL
);

-- Indexes
CREATE INDEX idx_chunk_session    ON chunk(session_id);
CREATE INDEX idx_chunk_project    ON chunk(project_id);
CREATE INDEX idx_chunk_type       ON chunk(content_type);
CREATE INDEX idx_chunk_agent      ON chunk(agent);
CREATE INDEX idx_chunk_time       ON chunk(time_created);
CREATE INDEX idx_chunk_tool       ON chunk(tool_name) WHERE tool_name IS NOT NULL;
CREATE INDEX idx_chunk_unembedded ON chunk(id) WHERE time_embedded IS NULL;
CREATE INDEX idx_chunk_hash       ON chunk(content_hash);  -- embedding cache lookups
CREATE INDEX idx_chunk_plan       ON chunk(plan_slug) WHERE plan_slug IS NOT NULL;
CREATE INDEX idx_chunk_root       ON chunk(root_session_id);
CREATE INDEX idx_archive_project  ON archive(project_id);
CREATE INDEX idx_type_proposal    ON type_proposal(proposed_type);
CREATE INDEX idx_retrieval_session ON retrieval_log(session_id);
```

### Size Estimates

For a project with 6k sessions producing ~50k high-signal chunks:
- Chunk text (~500 chars avg): ~25 MiB
- Embeddings (256-dim × 50k): ~50 MiB
- FTS5 index: ~15 MiB
- Vec index: ~10 MiB
- **Total: ~100 MiB** vs 12.7 GiB in `opencode.db`

---

## Capture Engine — What Gets Indexed

### High-Signal Content (captured in full)

| Source | Content Type | Where It Lives | What Engram Extracts |
|--------|-------------|----------------|---------------------|
| Orchestrator synthesis | `synthesis` | TextPart on assistant messages | Full text of orchestrator turns that follow task results |
| Planner analyses | `analysis` | TextPart from planner subagent sessions | Full reasoning about architecture, decomposition, tradeoffs |
| Journal entries | `decision` / `contract` / `discovery` / `pattern` | `journal.jsonl` (existing tool) | Mirrors journal writes for searchability |
| Executor notes | `discovery` | TextPart "Notes" sections from executor returns | Unexpected findings, assumptions, workarounds |
| Reasoning traces | `reasoning` | ReasoningPart | CoT that explains *why*, not just *what* (configurable — off by default, can be large) |
| Plan content | `plan` | PlanPart / `plans/*.md` (existing tool) | Mirrors plan writes |
| Error context | `error` | AssistantMessage.error + ToolPart error state | Error class, message, surrounding context |

### Low-Signal Content (metadata + truncated capture)

| Source | Content Type | Capture |
|--------|-------------|---------|
| Tool calls | `tool_trace` | `{tool_name, status, args_summary, output_head(200), output_tail(500), output_length, error_class, file_paths}` |
| Step boundaries | — | **Skipped entirely** — step-start/step-finish parts are not indexed |
| Patch parts | `tool_trace` | File list + hash only, no diff content |

### Content Classification

The capture engine classifies assistant text parts using `gpt-5.4-nano` as a lightweight LLM classifier. Classification happens **asynchronously** — not on the capture hot path.

**Two-phase approach:**

1. **Immediate (capture time):** A trivial rule assigns a provisional `content_type` based on agent role alone (`planner` → `analysis`, `orchestrator` → `synthesis`, everything else → `discovery`). This takes microseconds and lets the chunk be FTS-searchable immediately.

2. **Deferred (embed queue drain):** When the embed queue processes a batch, it piggybacks a nano classification call alongside the embedding API call. The classifier receives the chunk content + agent role + surrounding context and returns a precise `content_type` from the schema. The provisional type is overwritten with the LLM-derived type.

**Why LLM classification instead of regex:**

- Regex can't distinguish orchestrator synthesis ("here's what the executors produced and what it means") from orchestrator coordination ("delegating task X to executor-medium"). Both are orchestrator assistant messages, but only the first is `synthesis`.
- Regex can't detect `contract` content that doesn't literally contain the word "contract" — e.g., "the API will always return pagination metadata in this shape: `{cursor, hasMore, total}`" is a contract.
- New content patterns emerge over time. An LLM classifier handles novel patterns without code changes.
- The marginal cost is near-zero: nano at $0.20/M input tokens, ~200 tokens per classification = ~$0.00004 per chunk. For 50k chunks, that's ~$2 total.

**Evolving type schema:** The classifier is prompted with the current type enum but allowed to suggest a new type if none fit. New type suggestions are logged to a `type_proposals` table. When a proposed type appears 10+ times, it's surfaced in the `stats insights` report for the operator to promote into the schema. This gives Engram Factory Signals-style evolving facet classification without fully autonomous schema mutation.

Classification remains a **filter optimization**, not a correctness requirement — the embedding + reranker handle semantic matching regardless of type labels.

### Deduplication

Each chunk is hashed (SHA-256 of normalized, whitespace-collapsed content). Duplicate hashes within the same project are skipped. This handles the common case of branched subagent sessions producing near-identical outputs.

---

## Tools

Engram exposes four agent tools and a background archive system. The design principle: **maximum value, minimum cognitive load for the orchestrator.** The orchestrator should not need to think about embeddings, FTS, reranking, or retrieval pipelines. It calls `memory` with a question and gets answers. Destructive maintenance operations (archive deletion, vacuum) are human-facing CLI commands, not agent tools.

### `memory` — Search project memory

```typescript
export const memory = tool({
  description:
    "Search project memory for relevant past work: decisions, analyses, patterns, errors, and reasoning from previous sessions. Returns the most relevant matches with source citations. Use at session start to load context, before planning to check for prior art, and when debugging to find similar past errors.",
  args: {
    query: tool.schema
      .string()
      .describe("Natural language query — what you want to find"),
    scope: tool.schema
      .string()
      .optional()
      .describe(
        "Narrow results: 'decisions' | 'errors' | 'plans' | 'contracts' | 'recent'. Omit for broad search.",
      ),
    limit: tool.schema
      .number()
      .optional()
      .describe("Max results to return (default 5, max 10)"),
  },
})
```

**What the orchestrator sees** (example return):

```
## Memory Results (5 matches)

1. [session abc123 · planner · 2026-03-20]
   Auth middleware uses JWT validation against JWKS endpoint at /auth/keys with
   30s cache TTL. Token refresh handled client-side with 401 retry interceptor.
   Decision: stateless validation, no session store.

2. [session def456 · orchestrator · 2026-03-18]
   Rate limiting implemented as token-bucket in API gateway (100 req/min/user).
   Executor-medium failed twice on the Redis integration — promoted to
   executor-high. Root cause: connection pool exhaustion under test load.

3. ...

Sources: session:abc123, session:def456, ...
```

**Internal pipeline** (invisible to the agent):

1. Parse `scope` into content_type filter
2. FTS5 query for keyword candidates (top 50)
3. Embed query via `text-embedding-3-small`
4. Vector similarity scan over `chunk_vec` (top 30), merged with FTS results via reciprocal rank fusion
5. Send top 20 candidates + query to `gpt-5.4-nano` with ranking prompt
6. Return top N with formatted citations

**Latency budget**: FTS ~5ms + embed ~100ms + vector scan ~10ms + rerank ~400ms = **~515ms typical**.

### Archive — Background Export + Human-Facing CLI

Archive is **not an agent tool**. Agents don't have better information about session staleness than a simple age threshold, and destructive operations (deletion, vacuum) shouldn't be delegated to an LLM. Instead, archive has two components:

#### Background Export (automatic, non-destructive)

The plugin listens for `session.idle` events. When a root session tree has been idle for `staleDays` (default 30), the background export process runs automatically:

1. Walk session tree (root + all descendants via `parent_id`)
2. Backfill any high-signal content into `memory.db` that capture may have missed
3. Stream messages + parts as compressed JSONL to `~/.opencode/archives/{project_id}/{root_session_id}.jsonl.gz`
4. Write manifest row to `archive` table with content hash and row counts

This is idempotent — re-exporting an already-archived session is a no-op (content hash match). Export runs with streaming batches (500 rows per batch), yielding back to the event loop between batches. If export takes longer than 120 seconds, it checkpoints progress and resumes on the next idle event.

The export phase **never touches `opencode.db` writes** — it only reads. See "Archive Resilience" below for the ATTACH discussion.

#### CLI Commands (human-operated, destructive)

Deletion and vacuum are exposed as CLI subcommands, not agent tools:

```bash
# List archived sessions eligible for deletion
engram archive list

# Output:
# Archived sessions (exported, safe to delete):
#
#   ID               | Title                        | Sessions | Messages | Archive Size | DB Size
#   root-abc123      | Auth refactor                | 47       | 1,240    | 34 MiB       | ~180 MiB
#   root-def456      | Inbox UI overhaul            | 112      | 3,891    | 98 MiB       | ~520 MiB
#
# Total reclaimable: ~700 MiB

# Delete archived sessions from opencode.db (prompts for confirmation)
engram archive delete root-abc123 root-def456

# Delete + vacuum (warns about duration)
engram archive delete --vacuum root-abc123

# Verify archive integrity before deletion
engram archive verify root-abc123

# Force re-export (overwrites existing archive)
engram archive export --force root-abc123
```

**Why CLI instead of agent tool:**

- Deletion is irreversible. A human should confirm.
- VACUUM on a multi-GiB DB blocks writes for minutes. This should never happen mid-agent-session.
- The orchestrator gains nothing from deciding *when* to archive — it's a maintenance task, not a reasoning task.
- `engram archive list` gives the human operator visibility into DB health without burning agent tokens.

### `forget` — Redact content from memory

```typescript
export const forget = tool({
  description:
    "Remove specific chunks from project memory. Use to redact accidentally captured secrets, sensitive information, or incorrect entries. Accepts chunk IDs, session IDs, or content patterns.",
  args: {
    chunk_ids: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Specific chunk IDs to delete"),
    session_id: tool.schema
      .string()
      .optional()
      .describe("Delete all chunks from this session"),
    pattern: tool.schema
      .string()
      .optional()
      .describe("Delete chunks matching this text pattern (FTS5 query syntax)"),
    dry_run: tool.schema
      .boolean()
      .optional()
      .describe("Preview what would be deleted without deleting. Default true."),
  },
})
```

**Why this exists:** The `tool_trace` capture path stores head/tail of tool output. Even with truncation, 200+500 chars can capture API keys, credentials, or connection strings from error messages. Without `forget`, the only remediation is rebuilding the entire sidecar. `dry_run` defaults to true so agents can preview before committing.

### `stats` — Introspection, diagnostics, and friction insights

```typescript
export const stats = tool({
  description:
    "Project memory statistics and friction analysis: chunk counts by type, embedding coverage, storage sizes, error rates by agent tier, recurring failure patterns, and actionable insights. Use to understand project patterns, inform delegation decisions, and identify systemic issues.",
  args: {
    report: tool.schema
      .string()
      .optional()
      .describe(
        "'overview' (default) | 'tools' | 'errors' | 'files' | 'agents' | 'insights' | 'db-health'",
      ),
  },
})
```

**`overview`** returns:

```
Engram: 47,231 chunks indexed | 46,892 embedded (99.3%)
Memory DB: 94 MiB | Archive: 3 files, 1.2 GiB
Hot DB (opencode.db): 4.1 GiB (down from 12.7 GiB)

By type: synthesis 8,201 | analysis 5,440 | decision 1,156 | discovery 12,891
         tool_trace 18,102 | error 943 | plan 312 | contract 186

Last 7 days: 2,891 new chunks | 34 sessions | 12 root sessions
```

**`errors`** returns:

```
Error patterns (last 30 days):

  Agent Tier       | Tasks | Errors | Rate  | Top Error Class
  executor-low     | 312   | 47     | 15.1% | type_error (23), lint_fail (12)
  executor-medium  | 891   | 89     | 10.0% | test_fail (41), type_error (28)
  executor-high    | 234   | 12     | 5.1%  | test_fail (7), timeout (3)
  executor-genius  | 45    | 2      | 4.4%  | test_fail (2)

Recurring: "Redis connection pool exhaustion" appeared 4 times across 3 sessions
```

**`insights`** returns friction analysis (inspired by Factory Signals' friction detection). This report runs a periodic `gpt-5.4-nano` analysis over recent error, tool_trace, and synthesis chunks to surface systemic patterns:

```
Friction patterns (last 30 days, auto-detected):

  1. CONTEXT CHURN (high confidence, 23 occurrences)
     Executors re-request the same files 3+ times per session. DCP may be
     compressing file content that executors need repeatedly.
     → Recommendation: Pin frequently-accessed files in DCP override config.

  2. TIER ESCALATION THRASH (medium confidence, 8 occurrences)
     executor-low fails → promoted to executor-medium → succeeds on identical task.
     Recurring on: Redis integration, GraphQL resolver generation.
     → Recommendation: Update delegation heuristics — these task types should
       start at executor-medium.

  3. STALE CONTRACT (medium confidence, 5 occurrences)
     Executors produce code that violates contracts defined 10+ sessions ago.
     The contracts aren't in the live context window.
     → Recommendation: Auto-inject relevant contracts via proactive memory.

New type proposals: "migration_strategy" (12 occurrences), "perf_analysis" (7 occurrences)
```

The insights report is cached (regenerated at most once per day or on explicit request) to avoid redundant nano calls. Friction types are discovered by semantic clustering — the system can identify new friction categories without code changes.

**`db-health`** returns disk usage breakdown, stale embedding count, archive backlog, and `opencode.db` estimated reclaimable space.

---

## Performance Patterns

### Capture Path (hot — must not block agents)

- **Event listener** is synchronous but the work it triggers is not. The listener extracts content from the event payload (in-memory, microseconds), assigns a provisional content type based on agent role (microseconds), and pushes a record to an in-process write queue. LLM classification happens later in the embed queue.
- **Write queue** drains on a 500ms interval via `setInterval`. Each drain batch-inserts up to 50 chunks in a single SQLite transaction. At WAL mode with `PRAGMA synchronous = NORMAL`, a 50-row insert takes <5ms.
- **Embed + classify queue** is separate, drains on a 5s interval. Each drain cycle: (1) checks content-hash cache to skip already-embedded content (~30-50% cache hit rate on mature projects), (2) batches up to 100 uncached chunks per OpenAI embedding call, (3) fires a parallel nano classification call for the same batch. Both API calls are async and non-blocking. If either fails, chunks retain their provisional state and retry on next drain.
- **Zero backpressure on agents**: The event hook returns immediately. All DB writes and API calls happen asynchronously. An agent never waits for Engram.

### Query Path (warm — agent waits for this)

- **Target: <800ms end-to-end** for a `memory` tool call.
- FTS5 query: ~5ms (SQLite FTS on ~50k rows is trivial)
- Embed query: ~100ms (OpenAI API round-trip for a single short text)
- Vector scan: ~10ms (brute-force cosine on 50k × 256-dim is ~5ms; `sqlite-vec` ANN is similar at this scale)
- RRF merge: ~1ms (in-process sort)
- Rerank: ~400ms (`gpt-5.4-nano` with ~8k tokens input, streaming disabled)
- Format: ~1ms
- **Total: ~517ms typical, <1s P99**

If the OpenAI API is slow or down, Engram falls back to FTS + vector results without reranking. The `memory` tool still returns useful results — just less precisely ranked.

### Archive Path (cold — background or CLI, resilient)

- Session tree walk: ~100ms (recursive query on indexed `parent_id`)
- JSONL export: ~5s per 1000 messages (streamed in batches of 500, yielding between batches)
- Deletion (CLI only): ~2s per 1000 rows (batched `DELETE` in transactions of 500)
- VACUUM (CLI only): **minutes** on a multi-GiB DB — always explicit, never automatic

**Archive Resilience:**

The archive export needs to read from `opencode.db` (session trees, messages, parts). There are two approaches — we use **option B**:

- **Option A: ATTACH.** Open `opencode.db` as a read-only attached database from the `memory.db` connection. Pros: single connection, can JOIN across databases. Cons: holds a WAL read snapshot that blocks checkpointing on the hot DB; on a 12.7 GiB file with active writes, the WAL can balloon if the export takes too long.

- **Option B: Separate read-only connection.** Open a dedicated `new Database(path, {readonly: true})` for `opencode.db`. Read in batches of 500 rows, close the cursor between batches, yield to the event loop. Each batch opens a fresh read transaction, so WAL checkpointing isn't blocked between batches. This avoids holding a long-lived snapshot over a multi-GiB file.

**Timeout and progress:**

- Each export operation has a **120-second wall-clock timeout**. If exceeded, the export checkpoints its progress (last exported message ID) in the archive manifest and resumes from that point on the next idle event.
- Progress is logged to `memory.db` as the export runs: `{root_session_id, exported_count, total_count, phase}`. The `stats db-health` report surfaces in-progress exports.
- The CLI `engram archive export` command prints progress to stdout: `Exporting root-abc123: 1,200/3,891 messages (31%)...`

**Scheduling:**

- Background export triggers on `session.idle` events, but only runs when no agent sessions are actively executing (checked via OpenCode's session state). This prevents the export from competing for disk I/O during heavy parallel execution waves.
- The CLI commands can run any time — the operator accepts the performance impact.

### Resource Constraints

- **Memory**: Write queue bounded at 500 chunks (backpressure: drop oldest unembedded). Embed batch bounded at 100. No large in-memory buffers.
- **Disk**: `memory.db` grows at ~2 bytes per byte of indexed content (text + FTS + vec). For a project generating 10k chunks/month, that's ~10 MiB/month. Negligible relative to the GiBs it helps archive out of `opencode.db`.
- **Network**: Embedding calls at ~100 chunks/batch, ~5s interval = max 1200 chunks/minute. Rerank calls only on `memory` tool invocation (agent-driven, not continuous). Total API cost for a heavy session: <$0.01.
- **SQLite connections**: One read-write connection for Engram's `memory.db` (owned by the plugin, no contention). A separate read-only connection to `opencode.db` for archive operations, opened and closed per batch to avoid blocking WAL checkpoints.
- **CPU**: Content classification is a deferred nano LLM call (piggybacked on embed batches), not local compute. Embedding and reranking are API calls. The plugin's CPU footprint is effectively zero.

---

## Integration with Existing Tools

Engram does **not** replace the existing persistence tools. It augments them.

| Existing Tool | Engram Relationship |
|--------------|-------------------|
| `journal` (decision log) | Engram's event listener detects `journal_write` tool calls and indexes entries as `decision`/`contract`/`discovery`/`pattern` chunks. The journal remains the source of truth; Engram makes it searchable. |
| `handoff` (session resume) | Unchanged. Handoff is a single-document write/read for immediate session continuity. Engram provides deeper historical context that the handoff format can't carry. |
| `plan` (persisted plans) | Engram indexes plan writes as `plan` chunks. Agents can find past plans via `memory` query without knowing slugs. |
| `progress` (wave tracking) | Unchanged. Progress is ephemeral per-plan tracking. Engram captures the synthesis messages that reference progress state. |
| `status` (executor state) | Unchanged. Status files are live coordination artifacts. Engram captures the results, not the coordination. |
| DCP (`compress`) | DCP handles within-session context management. Engram captures content *before* DCP might compress it (via event listener on message creation, not on compression). They are complementary — DCP keeps the live context lean; Engram keeps the historical record complete. |

### Proactive Memory Injection (automatic, no tool call needed)

Engram uses the `experimental.chat.system.transform` hook to **automatically inject relevant memories** into every session's system prompt. This is the single most important integration point — it eliminates the failure mode of agents forgetting to call `memory`.

**How it works:**

1. When a new session starts, the hook fires with the session ID and model.
2. Engram reads the session's first user message (or the handoff document if it exists) to extract intent.
3. It runs a lightweight `memory` query (FTS + vector, no rerank — speed over precision for injection).
4. It appends a `<project_memory>` block to the system prompt containing the top 3-5 most relevant chunks, formatted as concise summaries with session citations.
5. Total injection budget: **max 2,000 tokens**. This keeps the system prompt lean while giving the agent critical historical context.

```
<!-- Injected by Engram -->
<project_memory>
Relevant context from past sessions:

• Auth middleware uses stateless JWT validation against JWKS at /auth/keys
  with 30s cache TTL. No session store. [session:abc123, 2026-03-20]

• Rate limiting: token-bucket in API gateway, 100 req/min/user. Redis
  connection pool exhaustion is a known issue under load — use pool size ≥20.
  [session:def456, 2026-03-18]

• Contract: All API responses include {cursor, hasMore, total} pagination
  metadata. Breaking this contract broke 3 frontend components last time.
  [session:ghi789, 2026-03-15]
</project_memory>
```

Agents still have the `memory` tool for explicit deep queries. Proactive injection handles the common case; the tool handles the targeted case.

### Orchestrator Prompt Addition

The orchestrator's `# Session startup` section gains one line:

```
7. `memory` — query for relevant past context if the auto-injected <project_memory> is insufficient or you need deeper historical search
```

The orchestrator's `# Delegation` table gains:

```
| Past context retrieval | `memory` tool | Deep search of project memory for decisions, patterns, errors, and reasoning from past sessions. |
| Content redaction       | `forget` tool | Remove accidentally captured secrets or incorrect entries from project memory. |
| System insights         | `stats insights` | Friction analysis — recurring failure patterns, tier escalation issues, stale contracts. |
```

### Structured Milestone Capture

The existing `progress` and `plan` tools track wave-level status, but don't emit structured completion events that Engram can index richly. Two small additions to the orchestrator's tool integration:

1. **Plan completion signal:** When the orchestrator writes a final progress update marking all waves as `done`, Engram captures a `milestone` chunk containing: the plan slug, title, total wave count, duration (first wave start → last wave done), executor tiers used, error count, and the orchestrator's final synthesis. This creates a searchable record of "what did we build and how did it go" that's richer than the plan file alone.

2. **Decision anchoring:** When the orchestrator writes a journal entry of type `decision` or `contract`, Engram links it to the active plan (if any) by adding `plan_slug` to the chunk metadata. This lets future `memory` queries like "what decisions did we make during the auth refactor?" return results scoped to that plan's decision chain, not just keyword matches.

The orchestrator doesn't need to change its behavior — it already writes to `journal` and `progress`. Engram listens via `tool.execute.after` and enriches the capture with structural context.

---

## Configuration

```jsonc
// .opencode/engram.jsonc
{
  "$schema": "https://engram.dev/config.json",
  "enabled": true,
  "sidecar": {
    "path": ".opencode/memory.db",        // relative to project root
    "dimensions": 256,                      // embedding dimensions (256 | 512 | 1024 | 1536)
    "maxChunkLength": 2000                  // truncate individual chunks (chars)
  },
  "capture": {
    "assistantText": true,                  // capture assistant TextParts
    "reasoning": false,                     // capture ReasoningParts (can be large)
    "toolTraces": true,                     // capture tool metadata + truncated output
    "toolOutputHead": 200,                  // chars from start of tool output
    "toolOutputTail": 500,                  // chars from end of tool output
    "journalMirror": true,                  // index journal writes
    "planMirror": true,                     // index plan writes
    "skipPartTypes": ["step-start", "step-finish", "snapshot"]
  },
  "classify": {
    "model": "gpt-5.4-nano",               // LLM classifier for content types
    "enabled": true,                        // disable to use provisional role-based types only
    "typeProposalThreshold": 10             // surface new type proposals after N occurrences
  },
  "embed": {
    "model": "text-embedding-3-small",
    "batchSize": 100,
    "intervalMs": 5000,
    "queueMax": 500,
    "cacheByHash": true                     // skip API call if content_hash already has embedding
  },
  "rerank": {
    "model": "gpt-5.4-nano",
    "candidates": 20,                      // send top N to reranker
    "enabled": true                         // disable to skip rerank (FTS + vector only)
  },
  "proactive": {
    "enabled": true,                        // auto-inject <project_memory> into system prompts
    "maxTokens": 2000,                      // token budget for injected context
    "maxChunks": 5,                         // max chunks to inject
    "skipRerank": true                      // use FTS + vector only for speed (no nano call)
  },
  "archive": {
    "path": "~/.opencode/archives",
    "staleDays": 30,                        // sessions inactive for N days trigger background export
    "autoCaptureBefore": true,              // backfill sidecar before archiving
    "exportTimeoutMs": 120000,              // max wall-clock time per export run
    "batchSize": 500,                       // rows per read batch (yields between batches)
    "onlyWhenIdle": true                    // only run background export when no agents are active
  },
  "insights": {
    "model": "gpt-5.4-nano",               // friction analysis model
    "cacheDays": 1,                         // regenerate insights report at most once per day
    "lookbackDays": 30                      // analyze chunks from the last N days
  }
}
```

---

## OpenCode Plugin Hooks Used

| Hook | Purpose |
|------|---------|
| `event` | Listen for `message.updated`, `message.part.updated`, `session.idle` events. Triggers capture and background archive export. |
| `tool.execute.after` | Capture tool call metadata, truncated output, error classification. Detect journal/progress writes for milestone and decision anchoring. |
| `tool` | Register `memory`, `forget`, and `stats` tools |
| `experimental.chat.system.transform` | **Proactive memory injection.** Auto-inject relevant `<project_memory>` block into session system prompts. |

### Hooks NOT Used

| Hook | Why Not |
|------|---------|
| `experimental.session.compacting` | DCP handles compression. Engram captures content via events, not compaction. |
| `experimental.chat.messages.transform` | DCP likely uses this for message transformation. Engram is read-only on the message stream — no conflict. |
| `chat.message` | Fires on user messages only. Engram needs assistant messages too — handled via `event`. |

---

## Learning Loop — Retrieval Quality Feedback

Engram tracks whether retrieved memories are actually *used* by agents, creating a feedback signal for retrieval tuning.

**Mechanism:**

1. When `memory` returns results, Engram logs the query and returned chunk IDs to `retrieval_log`.
2. The `tool.execute.after` hook monitors subsequent tool calls in the same session. If an agent edits a file, writes a plan, or produces output that references content from a retrieved chunk (detected via file path overlap, entity overlap, or direct citation), that chunk ID is added to `referenced_ids`.
3. Over time, chunks with high retrieval-but-low-reference rates are candidates for deprioritization. Chunks with high reference rates are candidates for boosting.

This is a **passive observation loop**, not an active retraining pipeline. In v1, the data is collected and surfaced in `stats insights`. In v2, it could weight the RRF merge or fine-tune reranker prompts.

---

## Embedding Cache by Content Hash

Inspired by Cursor's optimization: most edits leave most content unchanged, so embeddings can be cached by content hash.

Before calling the embedding API for a batch of chunks, Engram checks:

```sql
SELECT content_hash, embedding FROM chunk
WHERE content_hash IN (?, ?, ...) AND embedding IS NOT NULL
LIMIT 1  -- per hash
```

If a chunk with the same `content_hash` already has an embedding, the new chunk copies the vector directly — no API call needed. This handles the common case of branched subagent sessions producing near-identical reasoning, or the orchestrator re-synthesizing similar content across related sessions.

Estimated savings: 30-50% of embedding API calls for mature projects with recurring patterns.

---

## What Engram Is Not

- **Not a replacement for DCP.** DCP manages live context window pressure. Engram manages historical knowledge.
- **Not a replacement for the journal/handoff/plan/progress/status tools.** Those are write-time coordination artifacts. Engram is a read-time retrieval system that makes them searchable.
- **Not a training data pipeline.** The archive JSONL + retrieval feedback logs could feed one (the retrieval_log table is essentially preference data for retrieval model training), but Engram doesn't do redaction, SFT/DPO formatting, or export. That's a separate offline tool.
- **Not a vector database.** It's a SQLite file with an FTS5 table and a vec0 virtual table. It has no server, no replication, no auth. It's a file on your disk.
- **Not an agent tool for maintenance.** Archive deletion and vacuum are CLI commands for human operators. Agents query memory and write to it. They don't manage the database.

---

## Open Questions for Spec Phase

1. **`sqlite-vec` availability**: Does the Bun SQLite binding support loading extensions? If not, fall back to brute-force cosine similarity (viable at <100k vectors, ~10ms).
2. **Embedding API key**: Use the existing OpenAI key from `opencode.json` provider config, or require a separate key in `engram.jsonc`?
3. **Cross-project memory**: Current design is project-scoped. Should `memory` ever search across projects (e.g., shared patterns between `execintel` and `portal`)?
4. **Backfill strategy**: On first install against a 12.7 GiB DB, a full backfill could take hours of embedding API calls and significant cost. Options: (a) backfill everything, (b) backfill last N days only, (c) start fresh and let the sidecar grow organically. Recommend (b) with configurable window (default 90 days).
5. **Proactive injection query source**: The `experimental.chat.system.transform` hook fires before the session has messages. For resumed sessions, the handoff doc is the obvious query source. For new sessions, what do we use? Options: (a) wait for first user message and inject on second turn, (b) use the session title/description if available, (c) skip injection for brand-new sessions.
6. **Nano classification batching**: Should classification calls be 1:1 with chunks (simple, high latency per chunk) or batched (complex prompt, amortized latency)? Batched is cheaper but a single misparse loses multiple classifications.
7. **Retrieval feedback attribution**: How aggressively should we infer that a retrieved chunk was "used"? File path overlap is noisy (an agent might edit a file it already knew about). Entity/keyword overlap is better but still imprecise. Consider a lightweight LLM-as-judge call, but that adds cost to every retrieval.
8. **CLI distribution**: Should `engram archive` be a subcommand of the plugin itself (invoked via `opencode plugin engram archive list`), a standalone binary, or a script in the plugin package? The plugin API may not expose CLI hooks natively.

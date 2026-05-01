import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Database } from "bun:sqlite"
import type { EngramConfig } from "./config.ts"
import { defaultEngramConfig } from "./config.ts"
import { contentHash } from "./hash.ts"
import { topKByCosine } from "./cosine.ts"
import { openMemoryDb } from "./db.ts"
import { embedTexts, resolveApiKey } from "./openai.ts"
import { searchMemory } from "./retrieve.ts"
import { memorySnapshot, recordMetric } from "./telemetry.ts"

type SprintOpts = {
  cfg?: EngramConfig
  rows?: number
  live?: boolean
  rerank?: boolean
}

const sprintProject = "engram-manual-sprint"

export async function runManualSprint(opts: SprintOpts = {}): Promise<string> {
  const cfg = opts.cfg ?? defaultEngramConfig
  const rows = opts.rows ?? 3000
  const dir = mkdtempSync(path.join(os.tmpdir(), "engram-sprint-"))
  const db = openMemoryDb(path.join(dir, "memory.db"))
  const lines = [`Engram manual testing sprint`, `temp=${dir}`]

  try {
    lines.push(runLocalLatencySprint(db, cfg, rows))
    if (opts.live !== false) lines.push(await runLiveRetrievalFixture(db, cfg, opts.rerank === true))
    return lines.join("\n")
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function runLocalLatencySprint(db: Database, cfg: EngramConfig, rows: number): string {
  const before = memorySnapshot()
  const start = performance.now()
  const dim = cfg.sidecar.dimensions
  seedSyntheticRows(db, cfg, rows, dim)

  const ftsStart = performance.now()
  const ftsRows = db
    .prepare(
      `SELECT chunk_fts.chunk_id AS id
       FROM chunk_fts
       INNER JOIN chunk c ON c.id = chunk_fts.chunk_id
       WHERE chunk_fts MATCH ? AND c.project_id = ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all('"latencytoken"', sprintProject, cfg.memorySearch.kFts) as { id: string }[]
  const ftsMs = performance.now() - ftsStart

  const q = normBlob(Math.max(0, rows - 1), dim)
  const qv = new Float32Array(q.buffer, q.byteOffset, q.byteLength / 4)
  let candidates = 0
  const embRows = db
    .prepare(
      `SELECT id, embedding FROM chunk
       WHERE project_id = ? AND embedding_model = ? AND embedding_dimensions = ? AND embedding IS NOT NULL`,
    )
    .iterate(sprintProject, cfg.embed.model, dim) as Iterable<{
    id: string
    embedding: Buffer | Uint8Array | null
  }>
  const blobs = function* () {
    for (const r of embRows) {
      if (!r.embedding) continue
      candidates++
      yield { id: r.id, blob: r.embedding }
    }
  }
  const vecStart = performance.now()
  const top = topKByCosine(qv, blobs(), cfg.memorySearch.kVec)
  const vecMs = performance.now() - vecStart
  const durationMs = performance.now() - start

  recordMetric(db, {
    projectId: sprintProject,
    operation: "sprint.local_latency",
    status: "ok",
    durationMs,
    rowsCount: rows,
    before,
    after: memorySnapshot(),
    detail: {
      ftsMs,
      vecMs,
      ftsRows: ftsRows.length,
      vectorCandidates: candidates,
      topRows: top.length,
    },
  })

  return `LOCAL latency/memory: rows=${rows} fts=${round(ftsMs)}ms/${ftsRows.length} vec=${round(vecMs)}ms/${candidates} total=${round(durationMs)}ms top=${top[0]?.id ?? "none"}`
}

async function runLiveRetrievalFixture(db: Database, cfg: EngramConfig, rerank: boolean): Promise<string> {
  const key = resolveApiKey(cfg.openaiApiKey)
  if (!key) return "LIVE retrieval fixture: SKIP no OpenAI key resolved"

  const fixture = [
    {
      id: "fixture-auth-cookies",
      content: "Decision: use signed HttpOnly session cookies for auth and rotate session secrets during deploys.",
    },
    {
      id: "fixture-archive-verify",
      content: "Archive delete must verify gzip hash and archive metadata before removing hot opencode sessions.",
    },
    {
      id: "fixture-vector-index",
      content:
        "Performance recommendation: integrate sqlite-vec or an ANN index to avoid O(N times dimensions) vector scans.",
    },
    {
      id: "fixture-backfill-progress",
      content: "Backfill cursor advances only after captured rows are durably inserted into memory.db.",
    },
    {
      id: "fixture-ui-palette",
      content: "Design note: use restrained gradients and accessible contrast for dashboard cards.",
    },
  ]
  const queries = [
    { query: "How do we avoid losing backfill rows?", expected: "fixture-backfill-progress" },
    {
      query: "How does archive deletion know data is safe to remove?",
      expected: "fixture-archive-verify",
    },
    {
      query: "What removes the current vector retrieval bottleneck?",
      expected: "fixture-vector-index",
    },
  ]

  const sprintCfg = { ...cfg, rerank: { ...cfg.rerank, enabled: rerank } }
  const embedStart = performance.now()
  const embeddings = await embedTexts({
    key,
    model: cfg.embed.model,
    dimensions: cfg.sidecar.dimensions,
    inputs: fixture.map((f) => f.content),
  })
  for (let i = 0; i < fixture.length; i++) {
    const row = fixture[i]
    const embedding = embeddings[i]
    if (!row || !embedding) continue
    insertFixtureRow(db, sprintCfg, row.id, row.content, embedding)
  }
  const embedMs = performance.now() - embedStart

  let pass = 0
  const results: string[] = []
  for (const item of queries) {
    const before = memorySnapshot()
    const start = performance.now()
    const { hits, metrics } = await searchMemory({
      db,
      cfg: sprintCfg,
      projectId: sprintProject,
      query: item.query,
      limit: 3,
      key,
      skipRerank: !rerank,
    })
    const durationMs = performance.now() - start
    const rank = hits.findIndex((h) => h.id === item.expected) + 1
    const ok = rank > 0 && rank <= 3
    if (ok) pass++
    recordMetric(db, {
      projectId: sprintProject,
      operation: "sprint.live_retrieval",
      status: ok ? "ok" : "error",
      durationMs,
      rowsCount: hits.length,
      before,
      after: memorySnapshot(),
      detail: { expected: item.expected, rank, query: item.query, ...metrics },
    })
    results.push(`${ok ? "PASS" : "FAIL"} ${item.expected} rank=${rank || "miss"} ${round(durationMs)}ms`)
  }

  return [
    `LIVE retrieval fixture: pass=${pass}/${queries.length} fixtureEmbed=${round(embedMs)}ms rerank=${rerank}`,
    ...results,
  ].join("\n")
}

function seedSyntheticRows(db: Database, cfg: EngramConfig, rows: number, dim: number) {
  const ins = insertStatement(db)
  const now = Date.now()
  const tx = db.transaction(() => {
    for (let i = 0; i < rows; i++) {
      const id = `sprint-local-${i}`
      insertChunk(ins, cfg, id, `latencytoken retrieval performance fixture row ${i}`, normBlob(i, dim), now + i)
    }
  })
  tx()
}

function insertFixtureRow(db: Database, cfg: EngramConfig, id: string, content: string, embedding: number[]) {
  const f32 = new Float32Array(embedding)
  insertChunk(
    insertStatement(db),
    cfg,
    id,
    content,
    Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength),
    Date.now(),
  )
}

function insertStatement(db: Database) {
  return db.prepare(
    `INSERT INTO chunk (
      id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
      file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
      embedding, embedding_model, embedding_dimensions, time_created, time_embedded, content_hash,
      root_session_id, session_depth, plan_slug
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
}

function insertChunk(
  ins: ReturnType<Database["prepare"]>,
  cfg: EngramConfig,
  id: string,
  content: string,
  embedding: Buffer,
  timeCreated: number,
) {
  ins.run(
    id,
    "sprint-session",
    `${id}-message`,
    `${id}-part`,
    sprintProject,
    "assistant",
    "manual-sprint",
    null,
    "decision",
    content,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    embedding,
    cfg.embed.model,
    cfg.sidecar.dimensions,
    timeCreated,
    timeCreated,
    contentHash(content),
    "sprint-session",
    0,
    null,
  )
}

function normBlob(i: number, d: number): Buffer {
  const f = new Float32Array(d)
  for (let k = 0; k < d; k++) f[k] = Math.sin(i * 0.03 + k * 0.07)
  let s = 0
  for (let k = 0; k < d; k++) s += (f[k] ?? 0) * (f[k] ?? 0)
  s = Math.sqrt(s) || 1
  for (let k = 0; k < d; k++) f[k] = (f[k] ?? 0) / s
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength)
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

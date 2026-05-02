import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { ulid } from "ulid"
import { z } from "zod"
import type { EngramConfig } from "./config.ts"
import { defaultEngramConfig } from "./config.ts"
import { contentHash } from "./hash.ts"
import { embedTexts, resolveApiKey } from "./openai.ts"
import { searchMemory } from "./retrieve.ts"
import { openMemoryDb } from "./db.ts"
import { buildContextBundle, type ContextMode, type ContextSectionId } from "./context.ts"

const chunkSchema = z.object({
  id: z.string(),
  content: z.string(),
  type: z.string().default("decision"),
  agent: z.string().nullable().default("eval"),
})

const querySchema = z.object({
  id: z.string(),
  query: z.string(),
  expected: z.array(z.string()).min(1),
  scope: z.string().optional(),
  limit: z.number().int().positive().default(5),
})

const fixtureSchema = z.object({
  name: z.string(),
  projectId: z.string().default("engram-eval"),
  chunks: z.array(chunkSchema).default([]),
  queries: z.array(querySchema).min(1),
})

const contextChunkSchema = chunkSchema.extend({
  authority: z.number().default(8),
  sourceKind: z.string().nullable().default("fixture"),
  rootSessionId: z.string().nullable().optional(),
})

const contextQuerySchema = z.object({
  id: z.string(),
  query: z.string(),
  mode: z.enum(["plan", "implement", "review", "debug", "audit", "handoff"]).default("plan"),
  expectedSections: z.record(z.string(), z.array(z.string())).default({}),
  forbidden: z.array(z.string()).default([]),
  limit: z.number().int().positive().default(8),
})

const contextFixtureSchema = z.object({
  name: z.string(),
  projectId: z.string().default("engram-context-eval"),
  chunks: z.array(contextChunkSchema).default([]),
  queries: z.array(contextQuerySchema).min(1),
})

export type EvalFixture = z.infer<typeof fixtureSchema>
export type EvalQueryResult = {
  id: string
  query: string
  expected: string[]
  returned: string[]
  hit: boolean
  recall: number
  reciprocalRank: number
  latencyMs: number
}

export type EvalReport = {
  id: string
  fixtureName: string
  fixtureHash: string
  projectId: string
  k: number
  queryCount: number
  recallAtK: number
  hitAtK: number
  mrr: number
  p50Ms: number
  p95Ms: number
  results: EvalQueryResult[]
  timeCreated: number
}

export type ContextEvalFixture = z.infer<typeof contextFixtureSchema>
export type ContextEvalQueryResult = {
  id: string
  query: string
  mode: ContextMode
  sectionHit: boolean
  recallAtBudget: number
  staleRate: number
  noiseRate: number
  latencyMs: number
  expectedSections: Record<string, string[]>
  returnedBySection: Record<string, string[]>
  forbiddenReturned: string[]
}

export type ContextEvalReport = {
  id: string
  fixtureName: string
  fixtureHash: string
  projectId: string
  queryCount: number
  sectionHitRate: number
  recallAtBudget: number
  staleRate: number
  noiseRate: number
  p50Ms: number
  p95Ms: number
  results: ContextEvalQueryResult[]
  timeCreated: number
}

export type RunEvalOpts = {
  fixturePath: string
  cfg?: EngramConfig
  outDir?: string
  memoryDb?: Database
  queryId?: string
  live?: boolean
  rerank?: boolean
  useSidecar?: boolean
}

export type RunContextEvalOpts = {
  fixturePath: string
  cfg?: EngramConfig
  outDir?: string
  memoryDb?: Database
  queryId?: string
  useSidecar?: boolean
}

export async function runEval(opts: RunEvalOpts): Promise<EvalReport> {
  const cfg = opts.cfg ?? defaultEngramConfig
  const raw = readFileSync(opts.fixturePath, "utf8")
  const fixture = fixtureSchema.parse(JSON.parse(raw))
  const fixtureHash = createHash("sha256").update(raw).digest("hex")
  const selectedQueries = opts.queryId ? fixture.queries.filter((q) => q.id === opts.queryId) : fixture.queries
  if (selectedQueries.length === 0) throw new Error(`No query ${opts.queryId} in ${opts.fixturePath}`)

  if (!opts.useSidecar && fixture.chunks.length === 0)
    throw new Error("Eval fixture needs chunks unless --sidecar is used")
  if (opts.useSidecar && !opts.memoryDb) throw new Error("Sidecar eval requires memoryDb")
  const sidecarDb = opts.useSidecar ? opts.memoryDb : undefined
  const dir = path.join(os.tmpdir(), `engram-eval-${Date.now()}`)
  if (!opts.useSidecar) mkdirSync(dir, { recursive: true })
  const db = sidecarDb ?? openMemoryDb(path.join(dir, "memory.db"))
  try {
    const evalCfg = { ...cfg, rerank: { ...cfg.rerank, enabled: opts.rerank === true } }
    const key = opts.live === true ? resolveApiKey(cfg.openaiApiKey) : undefined
    if (!opts.useSidecar) await seedEvalDb(db, evalCfg, fixture, key)

    const results: EvalQueryResult[] = []
    for (const q of selectedQueries) {
      const start = performance.now()
      const queryEmbedding = key ? undefined : deterministicEmbedding(q.query, cfg.sidecar.dimensions)
      const { hits } = await searchMemory({
        db,
        cfg: evalCfg,
        projectId: fixture.projectId,
        query: q.query,
        scope: q.scope,
        limit: q.limit,
        key,
        skipRerank: opts.rerank !== true,
        queryEmbedding,
      })
      const returned = hits.map((h) => h.id)
      results.push(scoreQuery(q.id, q.query, q.expected, returned, performance.now() - start))
    }

    const report = buildReport(fixture, fixtureHash, Math.max(...selectedQueries.map((q) => q.limit)), results)
    if (opts.memoryDb) recordEvalRun(opts.memoryDb, report)
    if (opts.outDir) writeReport(opts.outDir, report)
    return report
  } finally {
    if (!opts.useSidecar) db.close()
  }
}

export function formatEvalReport(report: EvalReport): string {
  const lines = [
    `Engram eval ${report.fixtureName} (${report.queryCount} queries)`,
    `recall@${report.k}=${pct(report.recallAtK)} hit@${report.k}=${pct(report.hitAtK)} mrr=${round(report.mrr)} p50=${round(report.p50Ms)}ms p95=${round(report.p95Ms)}ms`,
  ]
  for (const r of report.results) {
    lines.push(
      `${r.hit ? "PASS" : "FAIL"} ${r.id} recall=${pct(r.recall)} rr=${round(r.reciprocalRank)} ${round(r.latencyMs)}ms returned=${r.returned.join(",")}`,
    )
  }
  return lines.join("\n")
}

export async function runContextEval(opts: RunContextEvalOpts): Promise<ContextEvalReport> {
  const cfg = opts.cfg ?? defaultEngramConfig
  const raw = readFileSync(opts.fixturePath, "utf8")
  const fixture = contextFixtureSchema.parse(JSON.parse(raw))
  const fixtureHash = createHash("sha256").update(raw).digest("hex")
  const queries = opts.queryId ? fixture.queries.filter((q) => q.id === opts.queryId) : fixture.queries
  if (queries.length === 0) throw new Error(`No query ${opts.queryId} in ${opts.fixturePath}`)

  if (!opts.useSidecar && fixture.chunks.length === 0)
    throw new Error("Context eval fixture needs chunks unless --sidecar is used")
  if (opts.useSidecar && !opts.memoryDb) throw new Error("Sidecar context eval requires memoryDb")
  const sidecarDb = opts.useSidecar ? opts.memoryDb : undefined
  const dir = path.join(os.tmpdir(), `engram-context-eval-${Date.now()}`)
  if (!opts.useSidecar) mkdirSync(dir, { recursive: true })
  const db = sidecarDb ?? openMemoryDb(path.join(dir, "memory.db"))
  try {
    if (!opts.useSidecar) seedContextEvalDb(db, cfg, fixture)
    const results: ContextEvalQueryResult[] = []
    for (const q of queries) {
      const start = performance.now()
      const bundle = buildContextBundle({
        db,
        projectId: fixture.projectId,
        query: q.query,
        mode: q.mode,
        limit: q.limit,
      })
      results.push(scoreContextQuery(q, bundle, performance.now() - start))
    }
    const report = buildContextReport(fixture, fixtureHash, results)
    if (opts.memoryDb) recordContextEvalRun(opts.memoryDb, report)
    if (opts.outDir) writeContextReport(opts.outDir, report)
    return report
  } finally {
    if (!opts.useSidecar) db.close()
  }
}

export function formatContextEvalReport(report: ContextEvalReport): string {
  const lines = [
    `Engram context eval ${report.fixtureName} (${report.queryCount} queries)`,
    `sectionHit=${pct(report.sectionHitRate)} recall@budget=${pct(report.recallAtBudget)} stale=${pct(report.staleRate)} noise=${pct(report.noiseRate)} p50=${round(report.p50Ms)}ms p95=${round(report.p95Ms)}ms`,
  ]
  for (const r of report.results) {
    lines.push(
      `${r.sectionHit ? "PASS" : "FAIL"} ${r.id} mode=${r.mode} recall=${pct(r.recallAtBudget)} stale=${pct(r.staleRate)} noise=${pct(r.noiseRate)} ${round(r.latencyMs)}ms`,
    )
  }
  return lines.join("\n")
}

function buildReport(fixture: EvalFixture, fixtureHash: string, k: number, results: EvalQueryResult[]): EvalReport {
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b)
  return {
    id: ulid(),
    fixtureName: fixture.name,
    fixtureHash,
    projectId: fixture.projectId,
    k,
    queryCount: results.length,
    recallAtK: avg(results.map((r) => r.recall)),
    hitAtK: avg(results.map((r) => (r.hit ? 1 : 0))),
    mrr: avg(results.map((r) => r.reciprocalRank)),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    results,
    timeCreated: Date.now(),
  }
}

function buildContextReport(
  fixture: ContextEvalFixture,
  fixtureHash: string,
  results: ContextEvalQueryResult[],
): ContextEvalReport {
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b)
  return {
    id: ulid(),
    fixtureName: fixture.name,
    fixtureHash,
    projectId: fixture.projectId,
    queryCount: results.length,
    sectionHitRate: avg(results.map((r) => (r.sectionHit ? 1 : 0))),
    recallAtBudget: avg(results.map((r) => r.recallAtBudget)),
    staleRate: avg(results.map((r) => r.staleRate)),
    noiseRate: avg(results.map((r) => r.noiseRate)),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    results,
    timeCreated: Date.now(),
  }
}

function scoreQuery(
  id: string,
  query: string,
  expected: string[],
  returned: string[],
  latencyMs: number,
): EvalQueryResult {
  const expectedSet = new Set(expected)
  const hits = returned.filter((id) => expectedSet.has(id))
  const firstRank = returned.findIndex((id) => expectedSet.has(id)) + 1
  return {
    id,
    query,
    expected,
    returned,
    hit: firstRank > 0,
    recall: hits.length / expected.length,
    reciprocalRank: firstRank > 0 ? 1 / firstRank : 0,
    latencyMs,
  }
}

function scoreContextQuery(
  query: z.infer<typeof contextQuerySchema>,
  bundle: ReturnType<typeof buildContextBundle>,
  latencyMs: number,
): ContextEvalQueryResult {
  const returnedBySection: Record<string, string[]> = {}
  const returned = new Set<string>()
  for (const section of bundle.sections) {
    returnedBySection[section.id] = section.items.map((item) => item.id)
    for (const item of section.items) returned.add(item.id)
  }
  const expected = Object.values(query.expectedSections).flat()
  const expectedReturned = expected.filter((id) => returned.has(id))
  const sectionHits = Object.entries(query.expectedSections).map(([section, ids]) => {
    const sectionReturned = new Set(returnedBySection[section] ?? [])
    return ids.every((id) => sectionReturned.has(id))
  })
  const forbiddenReturned = query.forbidden.filter((id) => returned.has(id))
  return {
    id: query.id,
    query: query.query,
    mode: query.mode,
    sectionHit: sectionHits.length ? sectionHits.every(Boolean) : expectedReturned.length === expected.length,
    recallAtBudget: expected.length ? expectedReturned.length / expected.length : 1,
    staleRate: forbiddenReturned.length ? 1 : 0,
    noiseRate: forbiddenReturned.length / Math.max(1, returned.size),
    latencyMs,
    expectedSections: query.expectedSections,
    returnedBySection,
    forbiddenReturned,
  }
}

async function seedEvalDb(db: Database, cfg: EngramConfig, fixture: EvalFixture, key: string | undefined) {
  const embeddings = key
    ? await embedTexts({
        key,
        model: cfg.embed.model,
        dimensions: cfg.sidecar.dimensions,
        inputs: fixture.chunks.map((c) => c.content),
      })
    : fixture.chunks.map((c) => deterministicEmbedding(c.content, cfg.sidecar.dimensions))
  const ins = db.prepare(
    `INSERT INTO chunk (
      id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
      file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
      embedding, embedding_model, embedding_dimensions, time_created, time_embedded, content_hash,
      root_session_id, session_depth, plan_slug
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  const now = Date.now()
  const tx = db.transaction(() => {
    for (let i = 0; i < fixture.chunks.length; i++) {
      const chunk = fixture.chunks[i]
      const embedding = embeddings[i]
      if (!chunk || !embedding) continue
      const f32 = new Float32Array(embedding)
      ins.run(
        chunk.id,
        "eval-session",
        `${chunk.id}-message`,
        `${chunk.id}-part`,
        fixture.projectId,
        "assistant",
        chunk.agent,
        null,
        chunk.type,
        chunk.content,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength),
        cfg.embed.model,
        cfg.sidecar.dimensions,
        now + i,
        now + i,
        contentHash(chunk.content),
        "eval-session",
        0,
        null,
      )
    }
  })
  tx()
}

function seedContextEvalDb(db: Database, cfg: EngramConfig, fixture: ContextEvalFixture) {
  const ins = db.prepare(
    `INSERT INTO chunk (
      id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
      file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
      embedding, embedding_model, embedding_dimensions, time_created, time_embedded, content_hash,
      root_session_id, session_depth, plan_slug, source_kind, source_ref, authority, superseded_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  const now = Date.now()
  const tx = db.transaction(() => {
    for (let i = 0; i < fixture.chunks.length; i++) {
      const chunk = fixture.chunks[i]
      if (!chunk) continue
      const embedding = deterministicEmbedding(chunk.content, cfg.sidecar.dimensions)
      const f32 = new Float32Array(embedding)
      ins.run(
        chunk.id,
        "context-eval-session",
        `${chunk.id}-message`,
        `${chunk.id}-part`,
        fixture.projectId,
        "assistant",
        chunk.agent,
        null,
        chunk.type,
        chunk.content,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength),
        cfg.embed.model,
        cfg.sidecar.dimensions,
        now + i,
        now + i,
        contentHash(chunk.content),
        chunk.rootSessionId ?? "context-eval-root",
        0,
        null,
        chunk.sourceKind,
        `fixture:${chunk.id}`,
        chunk.authority,
        null,
      )
    }
  })
  tx()
}

function recordEvalRun(db: Database, report: EvalReport) {
  db.prepare(
    `INSERT INTO eval_run (
      id, project_id, fixture_name, fixture_hash, report_json, recall_at_k, mrr, p50_ms, p95_ms, time_created
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    report.id,
    report.projectId,
    report.fixtureName,
    report.fixtureHash,
    JSON.stringify(report),
    report.recallAtK,
    report.mrr,
    report.p50Ms,
    report.p95Ms,
    report.timeCreated,
  )
}

function recordContextEvalRun(db: Database, report: ContextEvalReport) {
  db.prepare(
    `INSERT INTO eval_run (
      id, project_id, fixture_name, fixture_hash, report_json, recall_at_k, mrr, p50_ms, p95_ms, time_created
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    report.id,
    report.projectId,
    report.fixtureName,
    report.fixtureHash,
    JSON.stringify(report),
    report.sectionHitRate,
    report.recallAtBudget,
    report.p50Ms,
    report.p95Ms,
    report.timeCreated,
  )
}

function writeReport(outDir: string, report: EvalReport) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(path.join(outDir, "report.md"), `${formatEvalReport(report)}\n`)
}

function writeContextReport(outDir: string, report: ContextEvalReport) {
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(path.join(outDir, "report.md"), `${formatContextEvalReport(report)}\n`)
}

function deterministicEmbedding(text: string, dimensions: number): number[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean)
  const vec = new Float32Array(dimensions)
  for (const word of words) {
    const h = createHash("sha256").update(word).digest()
    const idx = h.readUInt32BE(0) % dimensions
    vec[idx] = (vec[idx] ?? 0) + 1
  }
  let sum = 0
  for (const v of vec) sum += v * v
  const norm = Math.sqrt(sum) || 1
  return Array.from(vec, (v) => v / norm)
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] ?? 0
}

function pct(n: number): string {
  return `${round(n * 100)}%`
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

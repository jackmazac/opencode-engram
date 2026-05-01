import type { Database } from "bun:sqlite"
import type { EngramConfig } from "./config.ts"
import { topKByCosine } from "./cosine.ts"
import { rrfMerge } from "./rrf.ts"
import { embedTexts, responsesStructured, rerankIdsSchema } from "./openai.ts"

const scopeTypes: Record<string, string[]> = {
  bugs: ["bug", "error"],
  contracts: ["contract", "api_contract", "invariant"],
  decisions: ["decision", "contract", "api_contract", "invariant"],
  errors: ["error", "bug"],
  plans: ["plan"],
  performance: ["perf_note"],
  requirements: ["product_requirement"],
  tests: ["test_strategy"],
}

export type MemoryHit = {
  id: string
  content: string
  session_id: string
  agent: string | null
  content_type: string
  time_created: number
}

export type SearchMetrics = {
  totalMs: number
  ftsMs: number
  embedMs: number
  vectorMs: number
  mergeMs: number
  rerankMs: number
  hydrateMs: number
  ftsCount: number
  vecCandidates: number
  vecCount: number
  mergedCount: number
  rerankCandidateCount: number
}

function ftsMatchQuery(q: string): string {
  const t = q.replace(/"/g, '""').trim()
  if (!t) return '""'
  return `"${t}"`
}

export function scopeClause(
  scope: string | undefined,
  cfg: EngramConfig,
  projectId: string,
): { sql: string; args: unknown[] } {
  const parts: string[] = []
  const args: unknown[] = []
  const graceMs = cfg.memorySearch.scopeIncludeUnembeddedGraceHours * 3600000
  const now = Date.now()

  if (!scope || scope === "broad") return { sql: "1", args: [] }

  if (scope === "recent") {
    const cut = now - cfg.memorySearch.recentDays * 86400000
    const lim = cfg.memorySearch.recentChunkLimit
    parts.push("(c.time_created >= ?)")
    args.push(cut)
    parts.push(`c.id IN (SELECT id FROM chunk WHERE project_id = ? ORDER BY time_created DESC LIMIT ?)`)
    args.push(projectId, lim)
    return { sql: parts.join(" AND "), args }
  }

  const types = scopeTypes[scope]
  if (types) {
    parts.push(`c.content_type IN (${types.map(() => "?").join(",")})`)
    args.push(...types)
    parts.push(`(c.time_embedded IS NOT NULL OR c.time_created >= ?)`)
    args.push(now - graceMs)
    return { sql: parts.join(" AND "), args }
  }

  return { sql: "1", args: [] }
}

export async function searchMemory(opts: {
  db: Database
  cfg: EngramConfig
  projectId: string
  query: string
  scope?: string
  limit: number
  key?: string
  skipRerank: boolean
  queryEmbedding?: number[]
}): Promise<{ hits: MemoryHit[]; ftsIds: string[]; vecIds: string[]; metrics: SearchMetrics }> {
  const totalStart = performance.now()
  let ftsMs = 0
  let embedMs = 0
  let vectorMs = 0
  let mergeMs = 0
  let rerankMs = 0
  let hydrateMs = 0
  let vecCandidates = 0
  const cfg = opts.cfg
  const kFts = cfg.memorySearch.kFts
  const kVec = cfg.memorySearch.kVec
  const kRerank = cfg.memorySearch.kRerank

  const lim = Math.min(Math.max(opts.limit, 1), 10)
  const sc = scopeClause(opts.scope, cfg, opts.projectId)
  const whereScope = sc.sql === "1" ? "1" : sc.sql
  const scopeArgs = sc.args

  const matchStr = ftsMatchQuery(opts.query)
  const ftsBind = [matchStr, opts.projectId, ...scopeArgs, kFts] as (string | number)[]
  const ftsStart = performance.now()
  const ftsIds = opts.db
    .query(
      `SELECT chunk_fts.chunk_id AS id
       FROM chunk_fts
       INNER JOIN chunk c ON c.id = chunk_fts.chunk_id
       WHERE chunk_fts MATCH ? AND c.project_id = ? AND (${whereScope})
       ORDER BY rank
       LIMIT ?`,
    )
    .all(...ftsBind) as { id: string }[]
  ftsMs = performance.now() - ftsStart

  const ftsRanked = ftsIds.map((x) => x.id)

  let qv = opts.queryEmbedding
  if (!qv) {
    if (!opts.key) throw new Error("embed: API key required")
    const embedStart = performance.now()
    const embBatch = await embedTexts({
      key: opts.key,
      model: cfg.embed.model,
      dimensions: cfg.sidecar.dimensions,
      inputs: [opts.query],
    })
    embedMs = performance.now() - embedStart
    qv = embBatch[0]
  }
  if (!qv) throw new Error("embed: empty response")
  const qvec = new Float32Array(qv)

  const vecBind = [opts.projectId, cfg.embed.model, cfg.sidecar.dimensions, ...scopeArgs] as (string | number)[]
  const embRows = opts.db
    .query(
      `SELECT c.id, c.embedding AS embedding
       FROM chunk c
       WHERE c.project_id = ?
         AND c.embedding_model = ?
         AND c.embedding_dimensions = ?
         AND c.embedding IS NOT NULL
         AND (${whereScope})`,
    )
    .iterate(...vecBind) as Iterable<{ id: string; embedding: Buffer | Uint8Array | null }>
  const blobs = function* () {
    for (const r of embRows) {
      if (!r.embedding) continue
      vecCandidates++
      yield { id: r.id, blob: r.embedding }
    }
  }
  const vectorStart = performance.now()
  const vecScored = topKByCosine(qvec, blobs(), kVec)
  vectorMs = performance.now() - vectorStart
  const vecRanked = vecScored.map((x) => x.id)

  const mergeStart = performance.now()
  const merged = applyFeedbackBoosts(opts.db, opts.projectId, rrfMerge([ftsRanked, vecRanked]))
  const topMerge = merged.slice(0, kRerank).map((x) => x.id)
  mergeMs = performance.now() - mergeStart

  let ordered = topMerge
  if (!opts.skipRerank && cfg.rerank.enabled && topMerge.length) {
    try {
      const rerankStart = performance.now()
      if (!opts.key) throw new Error("rerank: API key required")
      ordered = await rerank(opts.key, cfg.rerank.model, opts.query, topMerge, opts.db)
      rerankMs = performance.now() - rerankStart
    } catch {
      ordered = topMerge
    }
  }

  const ids = ordered.slice(0, lim)
  if (ids.length === 0)
    return {
      hits: [],
      ftsIds: ftsRanked,
      vecIds: vecRanked,
      metrics: buildMetrics({
        totalStart,
        ftsMs,
        embedMs,
        vectorMs,
        mergeMs,
        rerankMs,
        hydrateMs,
        ftsCount: ftsRanked.length,
        vecCandidates,
        vecCount: vecRanked.length,
        mergedCount: merged.length,
        rerankCandidateCount: topMerge.length,
      }),
    }

  const placeholders = ids.map(() => "?").join(",")
  const hydrateStart = performance.now()
  const rows = opts.db
    .query(
      `SELECT id, content, session_id, agent, content_type, time_created
       FROM chunk WHERE id IN (${placeholders})`,
    )
    .all(...ids) as MemoryHit[]
  hydrateMs = performance.now() - hydrateStart

  const order = new Map(ids.map((id, i) => [id, i]))
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))

  return {
    hits: rows,
    ftsIds: ftsRanked,
    vecIds: vecRanked,
    metrics: buildMetrics({
      totalStart,
      ftsMs,
      embedMs,
      vectorMs,
      mergeMs,
      rerankMs,
      hydrateMs,
      ftsCount: ftsRanked.length,
      vecCandidates,
      vecCount: vecRanked.length,
      mergedCount: merged.length,
      rerankCandidateCount: topMerge.length,
    }),
  }
}

function applyFeedbackBoosts(
  db: Database,
  projectId: string,
  ranked: { id: string; score: number }[],
): { id: string; score: number }[] {
  if (ranked.length === 0) return ranked
  const ids = ranked.map((r) => r.id)
  const placeholders = ids.map(() => "?").join(",")
  const rows = db
    .prepare(
      `SELECT chunk_id,
               sum(CASE rating WHEN 'up' THEN 1 WHEN 'down' THEN -1 ELSE 0 END) AS score
       FROM retrieval_feedback
       WHERE project_id = ? AND chunk_id IN (${placeholders})
       GROUP BY chunk_id`,
    )
    .all(projectId, ...ids) as { chunk_id: string; score: number | null }[]
  const feedback = new Map(rows.map((r) => [r.chunk_id, r.score ?? 0]))
  const authority = db
    .prepare(
      `SELECT id, content_type, source_kind, authority, superseded_by
       FROM chunk WHERE project_id = ? AND id IN (${placeholders})`,
    )
    .all(projectId, ...ids) as {
    id: string
    content_type: string
    source_kind: string | null
    authority: number
    superseded_by: string | null
  }[]
  const auth = new Map(authority.map((r) => [r.id, r]))
  return [...ranked]
    .map((r) => {
      const a = auth.get(r.id)
      const typeBoost =
        a && ["decision", "api_contract", "invariant", "plan", "analysis", "bug"].includes(a.content_type) ? 0.01 : 0
      const toolPenalty = a?.content_type === "tool_trace" ? -0.015 : 0
      const stalePenalty = a?.superseded_by ? -0.05 : 0
      return {
        ...r,
        score:
          r.score +
          (feedback.get(r.id) ?? 0) * 0.01 +
          (a?.authority ?? 0) * 0.002 +
          typeBoost +
          toolPenalty +
          stalePenalty,
      }
    })
    .sort((a, b) => b.score - a.score)
}

function buildMetrics(input: Omit<SearchMetrics, "totalMs"> & { totalStart: number }): SearchMetrics {
  return {
    totalMs: performance.now() - input.totalStart,
    ftsMs: input.ftsMs,
    embedMs: input.embedMs,
    vectorMs: input.vectorMs,
    mergeMs: input.mergeMs,
    rerankMs: input.rerankMs,
    hydrateMs: input.hydrateMs,
    ftsCount: input.ftsCount,
    vecCandidates: input.vecCandidates,
    vecCount: input.vecCount,
    mergedCount: input.mergedCount,
    rerankCandidateCount: input.rerankCandidateCount,
  }
}

async function rerank(key: string, model: string, query: string, ids: string[], db: Database): Promise<string[]> {
  const placeholders = ids.map(() => "?").join(",")
  const chunks = db.prepare(`SELECT id, content FROM chunk WHERE id IN (${placeholders})`).all(...ids) as {
    id: string
    content: string
  }[]
  const byId = new Map(chunks.map((c) => [c.id, c]))
  const pack = ids.map((id, i) => `${i + 1}. [${id}] ${(byId.get(id)?.content ?? "").slice(0, 400)}`).join("\n")

  const ins =
    'You rank passages by relevance to the user query. Respond with JSON: {"ids":["chunkId",...]} — chunk ids in best-first order. Use only ids from the list.'
  const inp = `Query: ${query}\n\nPassages:\n${pack}`

  const parsed = await responsesStructured({
    key,
    model,
    instructions: ins,
    input: inp,
    maxOutputTokens: 800,
    schemaName: "rerank_ids",
    schema: rerankIdsSchema,
  })
  const arr = parsed.ids
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of arr) {
    if (typeof id === "string" && ids.includes(id) && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) out.push(id)
  }
  return out
}

export function formatHits(hits: MemoryHit[]): string {
  if (hits.length === 0) return "No matching memories found."
  const lines = hits.map((h, i) => {
    const cite = `[session ${h.session_id.slice(0, 8)} · ${h.agent ?? "agent"} · ${new Date(h.time_created).toISOString().slice(0, 10)}]`
    return `${i + 1}. ${cite}\n   ${h.content.replace(/\s+/g, " ").slice(0, 800)}`
  })
  const src = hits.map((h) => `session:${h.session_id}`).join(", ")
  return `## Memory Results (${hits.length} matches)\n\n${lines.join("\n\n")}\n\nSources: ${src}`
}

import type { Database } from "bun:sqlite"
import type { EngramConfig } from "./config.ts"
import { topKByCosine } from "./cosine.ts"
import { rrfMerge } from "./rrf.ts"
import { embedTexts, responsesStructured, rerankIdsSchema } from "./openai.ts"

const scopeTypes: Record<string, string[]> = {
  decisions: ["decision", "contract"],
  errors: ["error"],
  plans: ["plan"],
  contracts: ["contract"],
}

export type MemoryHit = {
  id: string
  content: string
  session_id: string
  agent: string | null
  content_type: string
  time_created: number
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
    parts.push(
      `c.id IN (SELECT id FROM chunk WHERE project_id = ? ORDER BY time_created DESC LIMIT ?)`,
    )
    args.push(projectId, lim)
    return { sql: parts.join(" AND "), args }
  }

  const types = scopeTypes[scope]
  if (types) {
    parts.push(`c.content_type IN (${types.map(() => "?").join(",")})`)
    args.push(...types)
    parts.push(
      `(c.time_embedded IS NOT NULL OR c.time_created >= ?)`,
    )
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
  key: string
  skipRerank: boolean
}): Promise<{ hits: MemoryHit[]; ftsIds: string[]; vecIds: string[] }> {
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
  const ftsIds = opts.db
    .query(
      `SELECT f.chunk_id AS id
       FROM chunk_fts f
       INNER JOIN chunk c ON c.id = f.chunk_id
       WHERE f MATCH ? AND c.project_id = ? AND (${whereScope})
       ORDER BY rank
       LIMIT ?`,
    )
    .all(...ftsBind) as { id: string }[]

  const ftsRanked = ftsIds.map((x) => x.id)

  const embBatch = await embedTexts({
    key: opts.key,
    model: cfg.embed.model,
    dimensions: cfg.sidecar.dimensions,
    inputs: [opts.query],
  })
  const qv = embBatch[0]
  if (!qv) throw new Error("embed: empty response")
  const qvec = new Float32Array(qv)

  const vecBind = [opts.projectId, ...scopeArgs] as (string | number)[]
  const embRows = opts.db
    .query(
      `SELECT c.id, c.embedding AS embedding
       FROM chunk c
       WHERE c.project_id = ? AND c.embedding IS NOT NULL AND (${whereScope})`,
    )
    .all(...vecBind) as { id: string; embedding: Buffer }[]

  const blobs = embRows.map((r) => ({ id: r.id, blob: r.embedding }))
  const vecScored = topKByCosine(qvec, blobs, kVec)
  const vecRanked = vecScored.map((x) => x.id)

  const merged = rrfMerge([ftsRanked, vecRanked])
  const topMerge = merged.slice(0, kRerank).map((x) => x.id)

  let ordered = topMerge
  if (!opts.skipRerank && cfg.rerank.enabled && topMerge.length) {
    try {
      ordered = await rerank(opts.key, cfg.rerank.model, opts.query, topMerge, opts.db)
    } catch {
      ordered = topMerge
    }
  }

  const ids = ordered.slice(0, lim)
  if (ids.length === 0) return { hits: [], ftsIds: ftsRanked, vecIds: vecRanked }

  const placeholders = ids.map(() => "?").join(",")
  const rows = opts.db
    .query(
      `SELECT id, content, session_id, agent, content_type, time_created
       FROM chunk WHERE id IN (${placeholders})`,
    )
    .all(...ids) as MemoryHit[]

  const order = new Map(ids.map((id, i) => [id, i]))
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))

  return { hits: rows, ftsIds: ftsRanked, vecIds: vecRanked }
}

async function rerank(
  key: string,
  model: string,
  query: string,
  ids: string[],
  db: Database,
): Promise<string[]> {
  const placeholders = ids.map(() => "?").join(",")
  const chunks = db.prepare(`SELECT id, content FROM chunk WHERE id IN (${placeholders})`).all(...ids) as {
    id: string
    content: string
  }[]
  const byId = new Map(chunks.map((c) => [c.id, c]))
  const pack = ids.map((id, i) => `${i + 1}. [${id}] ${(byId.get(id)?.content ?? "").slice(0, 400)}`).join("\n")

  const ins =
    "You rank passages by relevance to the user query. Respond with JSON: {\"ids\":[\"chunkId\",...]} — chunk ids in best-first order. Use only ids from the list."
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

import { ulid } from "ulid"
import type { Database } from "bun:sqlite"
import type { EngramConfig } from "./config.ts"
import { classifyBatchSchema, responsesStructured, type ClassifyBatch } from "./openai.ts"

const allowed = new Set([
  "synthesis",
  "analysis",
  "decision",
  "discovery",
  "reasoning",
  "plan",
  "contract",
  "error",
  "tool_trace",
  "milestone",
  "pattern",
])

const sys = `Classify each chunk. Valid types: synthesis, analysis, decision, discovery, reasoning, plan, contract, error, tool_trace, milestone, pattern.
Respond with JSON only: object with key "items" — array of { id, type, confidence } where confidence is a number or null.
Include one item per chunk listed.`

function record(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x)
}

export function parseClassifyJsonLine(line: string): { id: string; type: string; confidence?: number } | undefined {
  const t = line.trim()
  if (!t.startsWith("{")) return undefined
  let row: unknown
  try {
    row = JSON.parse(t)
  } catch {
    return undefined
  }
  if (!record(row)) return undefined
  const id = row.id
  const ty = row.type
  const conf = row.confidence
  if (typeof id !== "string" || typeof ty !== "string") return undefined
  if (typeof conf === "number") return { id, type: ty, confidence: conf }
  return { id, type: ty }
}

function applyClassifyItems(db: Database, data: ClassifyBatch) {
  const insProposal = db.prepare(
    `INSERT INTO type_proposal (id, proposed_type, chunk_id, confidence, time_created) VALUES (?, ?, ?, ?, ?)`,
  )
  const upd = db.prepare(`UPDATE chunk SET content_type = ? WHERE id = ?`)
  let hits = 0
  const tx = db.transaction(() => {
    for (const it of data.items) {
      hits++
      if (allowed.has(it.type)) {
        upd.run(it.type, it.id)
        continue
      }
      const c = it.confidence
      insProposal.run(ulid(), it.type, it.id, c, Date.now())
    }
  })
  tx()
  return hits
}

export async function classifyBatch(opts: {
  db: Database
  cfg: EngramConfig
  key: string
  rows: { id: string; content: string; agent: string | null }[]
}): Promise<void> {
  if (!opts.cfg.classify.enabled || opts.rows.length === 0) return

  const run = async (slice: typeof opts.rows) => {
    const pack = slice
      .map((r, i) => `${i + 1}. id=${r.id} agent=${r.agent ?? ""} ${r.content.slice(0, 500)}`)
      .join("\n")
    const parsed = await responsesStructured({
      key: opts.key,
      model: opts.cfg.classify.model,
      instructions: sys,
      input: pack,
      maxOutputTokens: 800,
      schemaName: "classify_batch",
      schema: classifyBatchSchema,
    })
    return applyClassifyItems(opts.db, parsed)
  }

  const rows = opts.rows
  let hits = await run(rows)
  if (hits === 0 && rows.length > 1) {
    const mid = Math.floor(rows.length / 2)
    hits = (await run(rows.slice(0, mid))) + (await run(rows.slice(mid)))
  }
}

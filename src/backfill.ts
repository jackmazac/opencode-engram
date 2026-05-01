import type { Database } from "bun:sqlite"
import type { EngramConfig } from "./config.ts"
import * as capture from "./capture.ts"
import type { ChunkInsert } from "./types.ts"

function metaGet(db: Database, k: string): string | undefined {
  const r = db.query(`SELECT v FROM engram_meta WHERE k = ?`).get(k) as { v: string } | undefined
  return r?.v
}

function metaSet(db: Database, k: string, v: string) {
  db.prepare(`INSERT INTO engram_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, v)
}

export function backfillDone(memory: Database): boolean {
  return metaGet(memory, "backfill_v1_done") === "1"
}

function parseCursor(raw: string | undefined): { t: number; id: string } {
  if (!raw) return { t: 0, id: "" }
  const [a, b] = raw.split("\n")
  return { t: Number(a) || 0, id: b ?? "" }
}

export type BackfillResult = {
  rows: ChunkInsert[]
  cursor: { timeCreated: number; partId: string } | null
  done: boolean
}

function key(messageId: string, partId: string): string {
  return `${messageId}\0${partId}`
}

function existingPartKeys(
  memory: Database,
  projectId: string,
  rows: { message_id: string; part_id: string }[],
): Set<string> {
  const wanted = new Map<string, { messageId: string; partId: string }>()
  for (const r of rows) wanted.set(key(r.message_id, r.part_id), { messageId: r.message_id, partId: r.part_id })
  if (wanted.size === 0) return new Set()

  const clauses = Array.from(wanted.values())
    .map(() => `(message_id = ? AND coalesce(part_id, '') = ?)`)
    .join(" OR ")
  const args: string[] = [projectId]
  for (const r of wanted.values()) args.push(r.messageId, r.partId)

  const found = memory
    .query(
      `SELECT message_id, coalesce(part_id, '') AS part_key
       FROM chunk
       WHERE project_id = ? AND (${clauses})`,
    )
    .all(...args) as { message_id: string; part_key: string }[]

  return new Set(found.map((r) => key(r.message_id, r.part_key)))
}

/** Scan hot opencode.db for recent assistant parts and build chunks missing from memory.db (no network). */
export function backfillFromHot(opts: {
  hot: Database
  memory: Database
  projectId: string
  cfg: EngramConfig
  batchLimit: number
}): BackfillResult {
  const cfg = opts.cfg
  if (!cfg.backfill.enabled) return { rows: [], cursor: null, done: false }
  if (backfillDone(opts.memory)) return { rows: [], cursor: null, done: true }

  const cutoff = Date.now() - cfg.backfill.lookbackDays * 86400000
  const cur = parseCursor(metaGet(opts.memory, "backfill_cursor"))
  const startT = Math.max(cutoff, cur.t)
  const startId = cur.t > cutoff ? cur.id : ""

  const rows = opts.hot
    .query(
      `SELECT p.id AS part_id, p.session_id, p.message_id, p.time_created AS pt,
              p.data AS part_data, m.data AS msg_data
       FROM part p
       INNER JOIN message m ON m.id = p.message_id
       INNER JOIN session s ON s.id = p.session_id
       WHERE s.project_id = ?
         AND p.time_created >= ?
         AND (p.time_created > ? OR (p.time_created = ? AND p.id > ?))
       ORDER BY p.time_created ASC, p.id ASC
       LIMIT ?`,
    )
    .all(opts.projectId, cutoff, startT, startT, startId, opts.batchLimit) as {
    part_id: string
    session_id: string
    message_id: string
    pt: number
    part_data: string
    msg_data: string
  }[]

  const out: ChunkInsert[] = []
  const existing = existingPartKeys(opts.memory, opts.projectId, rows)

  for (const r of rows) {
    let info: { role?: string; agent?: string; modelID?: string }
    let raw: Record<string, unknown>
    try {
      info = JSON.parse(r.msg_data) as {
        role?: string
        agent?: string
        modelID?: string
      }
      raw = JSON.parse(r.part_data) as Record<string, unknown>
    } catch {
      continue
    }
    if (info.role !== "assistant") continue
    if (existing.has(key(r.message_id, r.part_id))) continue

    const part = {
      ...raw,
      id: r.part_id,
      sessionID: r.session_id,
      messageID: r.message_id,
    }
    const ctx = { agent: info.agent ?? null, model: info.modelID ?? null }
    out.push(...capture.fromPart(part, opts.projectId, cfg, null, ctx))
  }

  const last = rows[rows.length - 1]
  const done = rows.length < opts.batchLimit

  return {
    rows: out,
    cursor: last ? { timeCreated: last.pt, partId: last.part_id } : null,
    done,
  }
}

export function markBackfillProgress(memory: Database, result: BackfillResult) {
  if (result.cursor) metaSet(memory, "backfill_cursor", `${result.cursor.timeCreated}\n${result.cursor.partId}`)
  if (result.done) metaSet(memory, "backfill_v1_done", "1")
}

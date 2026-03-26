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

function parseCursor(raw: string | undefined): { t: number; id: string } {
  if (!raw) return { t: 0, id: "" }
  const [a, b] = raw.split("\n")
  return { t: Number(a) || 0, id: b ?? "" }
}

/** Scan hot opencode.db for recent assistant parts and build chunks missing from memory.db (no network). */
export function backfillFromHot(opts: {
  hot: Database
  memory: Database
  projectId: string
  cfg: EngramConfig
  batchLimit: number
}): ChunkInsert[] {
  const cfg = opts.cfg
  if (!cfg.backfill.enabled) return []
  const done = metaGet(opts.memory, "backfill_v1_done")
  if (done === "1") return []

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
    .all(
      opts.projectId,
      cutoff,
      startT,
      startT,
      startId,
      opts.batchLimit,
    ) as {
    part_id: string
    session_id: string
    message_id: string
    pt: number
    part_data: string
    msg_data: string
  }[]

  const out: ChunkInsert[] = []
  const exists = opts.memory.prepare(
    `SELECT 1 FROM chunk WHERE project_id = ? AND message_id = ? AND coalesce(part_id, '') = ? LIMIT 1`,
  )

  for (const r of rows) {
    const info = JSON.parse(r.msg_data) as { role?: string; agent?: string; modelID?: string }
    if (info.role !== "assistant") continue
    if (exists.get(opts.projectId, r.message_id, r.part_id)) continue

    const raw = JSON.parse(r.part_data) as Record<string, unknown>
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
  if (last) metaSet(opts.memory, "backfill_cursor", `${last.pt}\n${last.part_id}`)
  if (rows.length < opts.batchLimit) metaSet(opts.memory, "backfill_v1_done", "1")

  return out
}

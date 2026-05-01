import { Database } from "bun:sqlite"
import { ulid } from "ulid"
import type { EngramConfig } from "./config.ts"
import { applyConnPragmas } from "./db.ts"
import { contentHash } from "./hash.ts"

export type BackfillStrategy = "artifact-linked" | "priority" | "recent" | "errors" | "patches"
export type HotBackfillSummary = {
  dryRun: boolean
  strategy: BackfillStrategy
  roots: number
  scannedParts: number
  chunksInserted: number
}

type Root = { root_session_id: string; priority_score: number }

export function backfillHot(opts: {
  db: Database
  hotPath: string
  projectId: string
  cfg: EngramConfig
  strategy: BackfillStrategy
  dryRun: boolean
  maxRoots: number
  maxParts: number
}): HotBackfillSummary {
  const roots = selectRoots(opts.db, opts.projectId, opts.strategy, opts.maxRoots)
  const hot = new Database(opts.hotPath, { readonly: true })
  applyConnPragmas(hot)
  try {
    const candidates: Candidate[] = []
    for (const root of roots) {
      for (const part of rootCandidates(
        hot,
        opts.projectId,
        root.root_session_id,
        opts.strategy,
        opts.maxParts - candidates.length,
      )) {
        candidates.push(part)
        if (candidates.length >= opts.maxParts) break
      }
      if (candidates.length >= opts.maxParts) break
    }
    let inserted = 0
    if (!opts.dryRun) inserted = insertCandidates(opts.db, opts.projectId, opts.cfg, candidates)
    return {
      dryRun: opts.dryRun,
      strategy: opts.strategy,
      roots: roots.length,
      scannedParts: candidates.length,
      chunksInserted: inserted,
    }
  } finally {
    hot.close()
  }
}

export function formatHotBackfillSummary(s: HotBackfillSummary): string {
  return `Hot backfill ${s.dryRun ? "dry-run" : "applied"} strategy=${s.strategy} roots=${s.roots} scannedParts=${s.scannedParts} chunksInserted=${s.chunksInserted}`
}

type Candidate = {
  rootId: string
  sessionId: string
  messageId: string
  partId: string
  content: string
  type: string
  time: number
  sourceKind: string
  authority: number
}

function selectRoots(db: Database, projectId: string, strategy: BackfillStrategy, maxRoots: number): Root[] {
  if (strategy === "recent") {
    return db
      .prepare(
        `SELECT root_session_id, priority_score FROM session_root_index WHERE project_id = ? ORDER BY time_updated DESC LIMIT ?`,
      )
      .all(projectId, maxRoots) as Root[]
  }
  if (strategy === "artifact-linked") {
    const linked = db
      .prepare(
        `SELECT DISTINCT r.root_session_id, r.priority_score
         FROM session_root_index r
         INNER JOIN artifact_item a ON a.project_id = r.project_id
         WHERE r.project_id = ?
           AND (
             instr(lower(a.content), lower(r.title)) > 0
             OR (a.title IS NOT NULL AND instr(lower(r.title), lower(a.title)) > 0)
             OR (a.slug IS NOT NULL AND instr(lower(r.title), lower(a.slug)) > 0)
           )
         ORDER BY r.priority_score DESC
         LIMIT ?`,
      )
      .all(projectId, maxRoots) as Root[]
    if (linked.length) return linked
  }
  return db
    .prepare(
      `SELECT root_session_id, priority_score FROM session_root_index WHERE project_id = ? ORDER BY priority_score DESC LIMIT ?`,
    )
    .all(projectId, maxRoots) as Root[]
}

function rootCandidates(
  hot: Database,
  projectId: string,
  rootId: string,
  strategy: BackfillStrategy,
  limit: number,
): Candidate[] {
  if (limit <= 0) return []
  const sessions = hot
    .prepare(
      `WITH RECURSIVE t(id) AS (
         SELECT id FROM session WHERE id = ? AND project_id = ?
         UNION ALL SELECT s.id FROM session s INNER JOIN t ON s.parent_id = t.id
       ) SELECT id FROM t`,
    )
    .all(rootId, projectId) as { id: string }[]
  const ids = sessions.map((s) => s.id)
  if (ids.length === 0) return []
  const placeholders = ids.map(() => "?").join(",")
  const rows = hot
    .prepare(
      `SELECT p.id AS part_id, p.message_id, p.session_id, p.time_created, p.data AS part_data, m.data AS message_data
       FROM part p INNER JOIN message m ON m.id = p.message_id
       WHERE p.session_id IN (${placeholders})
       ORDER BY p.time_created DESC
       LIMIT ?`,
    )
    .all(...ids, Math.max(limit * 4, limit)) as {
    part_id: string
    message_id: string
    session_id: string
    time_created: number
    part_data: string
    message_data: string
  }[]
  const out: Candidate[] = []
  for (const row of rows) {
    const c = candidate(row, rootId, strategy)
    if (!c) continue
    out.push(c)
    if (out.length >= limit) break
  }
  return out
}

function candidate(
  row: {
    part_id: string
    message_id: string
    session_id: string
    time_created: number
    part_data: string
    message_data: string
  },
  rootId: string,
  strategy: BackfillStrategy,
): Candidate | null {
  let msg: { role?: string; agent?: string }
  let part: {
    type?: string
    text?: string
    tool?: string
    state?: { status?: string; output?: string; error?: string }
  }
  try {
    msg = JSON.parse(row.message_data) as { role?: string; agent?: string }
    part = JSON.parse(row.part_data) as {
      type?: string
      text?: string
      tool?: string
      state?: { status?: string; output?: string; error?: string }
    }
  } catch {
    return null
  }
  if (msg.role !== "assistant") return null
  if (part.type === "text" && part.text?.trim()) return base(row, rootId, part.text, "discovery", "hot_text", 2)
  if (part.type === "patch")
    return base(row, rootId, "Patch applied in implementation session.", "migration", "hot_patch", 5)
  if (part.type === "tool") {
    const tool = part.tool ?? "tool"
    const status = part.state?.status ?? "unknown"
    if (status === "completed" && ["read", "grep", "glob"].includes(tool)) return null
    if (strategy === "patches" && tool !== "apply_patch" && tool !== "edit") return null
    if (strategy === "errors" && status !== "error") return null
    const body = status === "error" ? (part.state?.error ?? "tool error") : `${tool} ${status}`
    return base(
      row,
      rootId,
      body,
      status === "error" ? "bug" : "tool_trace",
      `hot_tool:${tool}`,
      status === "error" ? 5 : 1,
    )
  }
  return null
}

function base(
  row: { part_id: string; message_id: string; session_id: string; time_created: number },
  rootId: string,
  content: string,
  type: string,
  sourceKind: string,
  authority: number,
): Candidate {
  return {
    rootId,
    sessionId: row.session_id,
    messageId: row.message_id,
    partId: row.part_id,
    content,
    type,
    time: row.time_created,
    sourceKind,
    authority,
  }
}

function insertCandidates(db: Database, projectId: string, cfg: EngramConfig, candidates: Candidate[]): number {
  let inserted = 0
  const exists = db.prepare(`SELECT 1 FROM chunk WHERE project_id = ? AND source_ref = ? LIMIT 1`)
  const stmt = db.prepare(
    `INSERT INTO chunk (
      id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
      file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
      time_created, content_hash, root_session_id, session_depth, plan_slug, source_kind, source_ref, authority
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  const tx = db.transaction(() => {
    for (const c of candidates) {
      const h = contentHash(c.content)
      const ref = `${c.sourceKind}:${c.partId}:${h}`
      if (exists.get(projectId, ref)) continue
      stmt.run(
        ulid(),
        c.sessionId,
        c.messageId,
        c.partId,
        projectId,
        "assistant",
        "hot-backfill",
        null,
        c.type,
        c.content.slice(0, cfg.sidecar.maxChunkLength),
        null,
        null,
        null,
        null,
        null,
        c.content.length,
        null,
        c.time,
        h,
        c.rootId,
        null,
        null,
        c.sourceKind,
        ref,
        c.authority,
      )
      inserted++
    }
  })
  tx()
  return inserted
}

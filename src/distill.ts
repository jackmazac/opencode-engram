import type { Database } from "bun:sqlite"
import { ulid } from "ulid"
import type { EngramConfig } from "./config.ts"
import { contentHash } from "./hash.ts"

export type DistillSummary = {
  dryRun: boolean
  roots: number
  distilled: number
  chunksInserted: number
}

export function distillRoots(opts: {
  db: Database
  projectId: string
  cfg: EngramConfig
  top: number
  dryRun: boolean
}): DistillSummary {
  const roots = opts.db
    .prepare(
      `SELECT root_session_id, title, child_count, message_count, part_count, tool_count, patch_count, reasoning_count,
              primary_agents_json, priority_score, content_hash
       FROM session_root_index
       WHERE project_id = ?
       ORDER BY priority_score DESC
       LIMIT ?`,
    )
    .all(opts.projectId, opts.top) as Root[]
  let chunksInserted = 0
  if (!opts.dryRun) chunksInserted = insertDistillations(opts.db, opts.projectId, opts.cfg, roots)
  return { dryRun: opts.dryRun, roots: roots.length, distilled: roots.length, chunksInserted }
}

export function formatDistillSummary(s: DistillSummary): string {
  return `Distill ${s.dryRun ? "dry-run" : "applied"} roots=${s.roots} distilled=${s.distilled} chunksInserted=${s.chunksInserted}`
}

type Root = {
  root_session_id: string
  title: string | null
  child_count: number
  message_count: number
  part_count: number
  tool_count: number
  patch_count: number
  reasoning_count: number
  primary_agents_json: string
  priority_score: number
  content_hash: string
}

function insertDistillations(db: Database, projectId: string, cfg: EngramConfig, roots: Root[]): number {
  let inserted = 0
  const now = Date.now()
  const insDistill = db.prepare(
    `INSERT OR IGNORE INTO session_distillation (
      id, project_id, root_session_id, model, summary_json, source_hash, token_estimate, time_created
    ) VALUES (?,?,?,?,?,?,?,?)`,
  )
  const existsChunk = db.prepare(`SELECT 1 FROM chunk WHERE project_id = ? AND source_ref = ? LIMIT 1`)
  const insChunk = db.prepare(
    `INSERT INTO chunk (
      id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
      file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
      time_created, content_hash, root_session_id, session_depth, plan_slug, source_kind, source_ref, authority
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  const tx = db.transaction(() => {
    for (const r of roots) {
      const summary = summarize(r)
      const sourceHash = contentHash(JSON.stringify(summary))
      insDistill.run(
        ulid(),
        projectId,
        r.root_session_id,
        "deterministic",
        JSON.stringify(summary),
        sourceHash,
        summary.content.length / 4,
        now,
      )
      const ref = `distill:${r.root_session_id}:${sourceHash}`
      if (existsChunk.get(projectId, ref)) continue
      insChunk.run(
        ulid(),
        r.root_session_id,
        `distill:${r.root_session_id}`,
        null,
        projectId,
        "assistant",
        "engram-distill",
        null,
        "synthesis",
        summary.content.slice(0, cfg.sidecar.maxChunkLength),
        null,
        null,
        null,
        null,
        null,
        summary.content.length,
        null,
        now,
        contentHash(summary.content),
        r.root_session_id,
        0,
        null,
        "distillation",
        ref,
        9,
      )
      inserted++
    }
  })
  tx()
  return inserted
}

function summarize(r: Root): { title: string; content: string; stats: Record<string, number> } {
  const title = r.title ?? r.root_session_id
  const agents = safeAgents(r.primary_agents_json)
  const content = [
    `Session distillation: ${title}`,
    `Root ${r.root_session_id} coordinated ${r.child_count} child sessions, ${r.message_count} messages, ${r.part_count} parts.`,
    `Primary agents: ${agents.join(", ") || "unknown"}.`,
    `Signals: patches=${r.patch_count}, tools=${r.tool_count}, reasoning=${r.reasoning_count}, priority=${Math.round(r.priority_score)}.`,
  ].join("\n")
  return {
    title,
    content,
    stats: {
      childCount: r.child_count,
      messageCount: r.message_count,
      partCount: r.part_count,
      patchCount: r.patch_count,
      toolCount: r.tool_count,
    },
  }
}

function safeAgents(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as Array<[string, number]>
    return parsed.map(([name, count]) => `${name}(${count})`).slice(0, 5)
  } catch {
    return []
  }
}

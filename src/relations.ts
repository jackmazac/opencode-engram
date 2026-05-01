import type { Database } from "bun:sqlite"
import { ulid } from "ulid"

export type RelationSummary = { dryRun: boolean; relations: number; superseded: number }

export function buildMemoryRelations(opts: {
  db: Database
  projectId: string
  dryRun: boolean
  max: number
}): RelationSummary {
  const rows = opts.db
    .prepare(
      `SELECT id, source_kind, source_ref, plan_slug, content_hash, time_created
       FROM chunk
       WHERE project_id = ? AND (source_kind IS NOT NULL OR plan_slug IS NOT NULL)
       ORDER BY coalesce(plan_slug, source_ref, content_hash), time_created DESC
       LIMIT ?`,
    )
    .all(opts.projectId, opts.max * 4) as {
    id: string
    source_kind: string | null
    source_ref: string | null
    plan_slug: string | null
    content_hash: string
    time_created: number
  }[]
  const groups = new Map<string, typeof rows>()
  for (const row of rows) {
    const key = row.plan_slug ?? row.source_ref?.replace(/:[a-f0-9]{64}$/, "") ?? row.content_hash
    const g = groups.get(key)
    if (g) g.push(row)
    else groups.set(key, [row])
  }

  const relations: Array<{ from: string; to: string; relation: string }> = []
  for (const group of groups.values()) {
    const sorted = group.sort((a, b) => b.time_created - a.time_created)
    const newest = sorted[0]
    if (!newest) continue
    for (const old of sorted.slice(1)) relations.push({ from: newest.id, to: old.id, relation: "supersedes" })
  }
  const limited = relations.slice(0, opts.max)
  if (!opts.dryRun) {
    const ins = opts.db.prepare(
      `INSERT OR IGNORE INTO memory_relation (id, project_id, from_chunk_id, to_chunk_id, relation, confidence, source, time_created)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    const upd = opts.db.prepare(`UPDATE chunk SET superseded_by = ? WHERE id = ? AND project_id = ?`)
    const now = Date.now()
    const tx = opts.db.transaction(() => {
      for (const r of limited) {
        ins.run(ulid(), opts.projectId, r.from, r.to, r.relation, 0.8, "deterministic", now)
        if (r.relation === "supersedes") upd.run(r.from, r.to, opts.projectId)
      }
    })
    tx()
  }
  return {
    dryRun: opts.dryRun,
    relations: limited.length,
    superseded: limited.filter((r) => r.relation === "supersedes").length,
  }
}

export function formatRelationSummary(s: RelationSummary): string {
  return `Relations ${s.dryRun ? "dry-run" : "applied"} relations=${s.relations} superseded=${s.superseded}`
}

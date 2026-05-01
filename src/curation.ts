import type { Database } from "bun:sqlite"
import { ulid } from "ulid"

export type CurationSummary = {
  runId: string
  applied: boolean
  duplicateGroups: number
  duplicateChunks: number
  lowValueChunks: number
}

type Proposal = {
  action: "delete_duplicate" | "review_low_value"
  chunkId: string
  reason: string
  duplicateOf: string | null
  score: number
}

export function runCuration(opts: { db: Database; projectId: string; apply: boolean; max: number }): CurationSummary {
  const proposals = buildProposals(opts.db, opts.projectId, opts.max)
  const runId = ulid()
  const duplicateGroups = new Set(proposals.filter((p) => p.duplicateOf).map((p) => p.duplicateOf)).size
  const summary: CurationSummary = {
    runId,
    applied: opts.apply,
    duplicateGroups,
    duplicateChunks: proposals.filter((p) => p.action === "delete_duplicate").length,
    lowValueChunks: proposals.filter((p) => p.action === "review_low_value").length,
  }

  const insRun = opts.db.prepare(
    `INSERT INTO curation_run (id, project_id, mode, applied, summary_json, time_created) VALUES (?,?,?,?,?,?)`,
  )
  const insProposal = opts.db.prepare(
    `INSERT INTO curation_proposal (
      id, run_id, project_id, action, chunk_id, reason, duplicate_of, score, applied, time_created
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
  const del = opts.db.prepare(`DELETE FROM chunk WHERE id = ? AND project_id = ?`)
  const now = Date.now()
  const tx = opts.db.transaction(() => {
    insRun.run(runId, opts.projectId, "default", opts.apply ? 1 : 0, JSON.stringify(summary), now)
    for (const p of proposals) {
      const applied = opts.apply && p.action === "delete_duplicate" ? 1 : 0
      insProposal.run(
        ulid(),
        runId,
        opts.projectId,
        p.action,
        p.chunkId,
        p.reason,
        p.duplicateOf,
        p.score,
        applied,
        now,
      )
      if (applied) del.run(p.chunkId, opts.projectId)
    }
  })
  tx()
  return summary
}

export function formatCurationSummary(summary: CurationSummary): string {
  return [
    `Curation ${summary.applied ? "applied" : "dry-run"} ${summary.runId}`,
    `duplicateGroups=${summary.duplicateGroups} duplicateChunks=${summary.duplicateChunks} lowValueChunks=${summary.lowValueChunks}`,
  ].join("\n")
}

function buildProposals(db: Database, projectId: string, max: number): Proposal[] {
  const proposals: Proposal[] = []
  const duplicateRows = db
    .prepare(
      `SELECT content_hash, group_concat(id) AS ids, count(*) AS n
       FROM chunk
       WHERE project_id = ?
       GROUP BY content_hash
       HAVING n > 1
       ORDER BY n DESC
       LIMIT ?`,
    )
    .all(projectId, max) as { content_hash: string; ids: string; n: number }[]
  for (const row of duplicateRows) {
    const ids = row.ids.split(",")
    const keeper = ids[0]
    if (!keeper) continue
    for (const id of ids.slice(1)) {
      proposals.push({
        action: "delete_duplicate",
        chunkId: id,
        reason: `duplicate content_hash ${row.content_hash}`,
        duplicateOf: keeper,
        score: row.n,
      })
    }
  }

  const lowValue = db
    .prepare(
      `SELECT id, length(content) AS len, content_type
       FROM chunk
       WHERE project_id = ? AND (length(trim(content)) < 24 OR content_type = 'tool_trace')
       ORDER BY time_created ASC
       LIMIT ?`,
    )
    .all(projectId, max) as { id: string; len: number; content_type: string }[]
  for (const row of lowValue) {
    if (proposals.some((p) => p.chunkId === row.id)) continue
    proposals.push({
      action: "review_low_value",
      chunkId: row.id,
      reason: row.content_type === "tool_trace" ? "tool_trace review candidate" : `short content (${row.len} chars)`,
      duplicateOf: null,
      score: row.len,
    })
  }

  return proposals.slice(0, max)
}

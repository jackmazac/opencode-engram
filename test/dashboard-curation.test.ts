import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { defaultEngramConfig } from "../src/config.ts"
import { formatCurationSummary, runCuration } from "../src/curation.ts"
import { buildDashboardReport, formatDashboardReport } from "../src/dashboard.ts"
import { openMemoryDb } from "../src/db.ts"

describe("dashboard and curation", () => {
  test("reports sidecar health and proposes duplicate cleanup", () => {
    const dir = path.join(os.tmpdir(), `engram-dashboard-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const db = openMemoryDb(path.join(dir, "memory.db"))

    insertChunk(db, "c1", "duplicate content worth keeping", "same-hash", "decision")
    insertChunk(db, "c2", "duplicate content worth keeping", "same-hash", "decision")
    insertChunk(db, "c3", "tiny", "tiny-hash", "discovery")

    db.prepare(
      `INSERT INTO eval_run (id, project_id, fixture_name, fixture_hash, report_json, recall_at_k, mrr, p50_ms, p95_ms, time_created)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run("eval1", "proj1", "core", "hash", "{}", 1, 1, 2, 3, Date.now())

    const dashboard = buildDashboardReport({
      db,
      projectId: "proj1",
      cfg: defaultEngramConfig,
      worktree: dir,
    })
    expect(dashboard.memory.chunks).toBe(3)
    expect(dashboard.eval.latest?.fixture).toBe("core")
    expect(formatDashboardReport(dashboard)).toContain("Engram dashboard")

    const dry = runCuration({ db, projectId: "proj1", apply: false, max: 20 })
    expect(dry.duplicateChunks).toBe(1)
    expect(dry.lowValueChunks).toBe(1)
    expect(formatCurationSummary(dry)).toContain("dry-run")
    const stillThere = db.query(`SELECT count(*) AS c FROM chunk WHERE project_id = ?`).get("proj1") as { c: number }
    expect(stillThere.c).toBe(3)

    const applied = runCuration({ db, projectId: "proj1", apply: true, max: 20 })
    expect(applied.applied).toBe(true)
    const remaining = db.query(`SELECT count(*) AS c FROM chunk WHERE project_id = ?`).get("proj1") as { c: number }
    expect(remaining.c).toBe(2)

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

function insertChunk(db: ReturnType<typeof openMemoryDb>, id: string, content: string, hash: string, type: string) {
  db.prepare(
    `INSERT INTO chunk (
      id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
      file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
      time_created, content_hash, root_session_id, session_depth, plan_slug
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    "s1",
    `${id}-message`,
    `${id}-part`,
    "proj1",
    "assistant",
    "test",
    null,
    type,
    content,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    Date.now(),
    hash,
    "s1",
    0,
    null,
  )
}

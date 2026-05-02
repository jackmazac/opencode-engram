import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { formatContextEvalReport, formatEvalReport, runContextEval, runEval } from "../src/eval.ts"
import { openMemoryDb } from "../src/db.ts"

describe("memory eval", () => {
  test("runs checked-in fixture and records drift metadata", async () => {
    const dir = path.join(os.tmpdir(), `engram-eval-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const db = openMemoryDb(path.join(dir, "memory.db"))
    const fixturePath = path.join(process.cwd(), "eval", "fixtures", "core.json")

    const report = await runEval({ fixturePath, memoryDb: db })
    expect(report.queryCount).toBeGreaterThan(0)
    expect(report.hitAtK).toBeGreaterThan(0.75)
    expect(report.mrr).toBeGreaterThan(0)
    expect(formatEvalReport(report)).toContain("Engram eval core")

    const row = db.query(`SELECT fixture_name, recall_at_k FROM eval_run`).get() as
      | { fixture_name: string; recall_at_k: number }
      | undefined
    expect(row?.fixture_name).toBe("core")
    expect(row?.recall_at_k).toBe(report.recallAtK)

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("runs checked-in context fixture and records section quality", async () => {
    const dir = path.join(os.tmpdir(), `engram-context-eval-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const db = openMemoryDb(path.join(dir, "memory.db"))
    const fixturePath = path.join(process.cwd(), "eval", "fixtures", "context-core.json")

    const report = await runContextEval({ fixturePath, memoryDb: db })
    expect(report.queryCount).toBe(3)
    expect(report.sectionHitRate).toBe(1)
    expect(report.recallAtBudget).toBe(1)
    expect(report.noiseRate).toBe(0)
    expect(formatContextEvalReport(report)).toContain("Engram context eval context-core")

    const row = db.query(`SELECT fixture_name, recall_at_k, mrr FROM eval_run`).get() as
      | { fixture_name: string; recall_at_k: number; mrr: number }
      | undefined
    expect(row?.fixture_name).toBe("context-core")
    expect(row?.recall_at_k).toBe(report.sectionHitRate)
    expect(row?.mrr).toBe(report.recallAtBudget)

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("runs context eval against an existing sidecar", async () => {
    const dir = path.join(os.tmpdir(), `engram-context-sidecar-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const db = openMemoryDb(path.join(dir, "memory.db"))
    db.prepare(
      `INSERT INTO chunk (
        id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
        file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
        time_created, content_hash, root_session_id, session_depth, plan_slug, source_kind, source_ref, authority, superseded_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "sidecar-contract",
      "s1",
      "m1",
      "p1",
      "sidecar-project",
      "assistant",
      "eval",
      null,
      "api_contract",
      "Sidecar context eval should use existing memory chunks without seeding synthetic fixtures.",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      Date.now(),
      "hash-sidecar-contract",
      "root1",
      0,
      null,
      "journal",
      "fixture:sidecar-contract",
      10,
      null,
    )
    const fixturePath = path.join(dir, "sidecar-context.json")
    writeFileSync(
      fixturePath,
      JSON.stringify({
        name: "sidecar-context",
        projectId: "sidecar-project",
        queries: [
          {
            id: "q-sidecar",
            query: "existing memory chunks synthetic fixtures",
            mode: "implement",
            expectedSections: { must_know: ["sidecar-contract"] },
            forbidden: [],
            limit: 5,
          },
        ],
      }),
    )

    const report = await runContextEval({ fixturePath, memoryDb: db, useSidecar: true })
    expect(report.sectionHitRate).toBe(1)
    expect(report.recallAtBudget).toBe(1)

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

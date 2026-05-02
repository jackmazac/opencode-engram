import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
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
})

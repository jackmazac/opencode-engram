import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { openMemoryDb } from "../src/db.ts"
import { formatTelemetryReport, memorySnapshot, pruneMetrics, recentMetrics, recordMetric } from "../src/telemetry.ts"

describe("telemetry", () => {
  test("records, summarizes, and prunes operation metrics", () => {
    const dir = path.join(os.tmpdir(), `engram-telemetry-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const db = openMemoryDb(path.join(dir, "memory.db"))
    const before = memorySnapshot()
    const now = Date.now()

    recordMetric(db, {
      projectId: "p1",
      operation: "memory.search",
      status: "ok",
      durationMs: 12.34,
      rowsCount: 3,
      before,
      after: memorySnapshot(),
      detail: { ftsMs: 1, vectorMs: 2 },
      timeCreated: now,
    })

    const rows = recentMetrics(db, "p1", 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.operation).toBe("memory.search")
    expect(formatTelemetryReport(rows)).toContain("memory.search:ok")

    pruneMetrics(db, "p1", 1, now + 2 * 86400000)
    expect(recentMetrics(db, "p1", 10)).toHaveLength(0)

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

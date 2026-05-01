import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { defaultEngramConfig } from "../src/config.ts"
import { openMemoryDb } from "../src/db.ts"
import {
  EngramLogger,
  formatEventReport,
  pruneLogEvents,
  recentLogEvents,
  recordLogEvent,
  trimLogEvents,
} from "../src/logger.ts"
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

  test("records, filters, truncates, and prunes log events", () => {
    const dir = path.join(os.tmpdir(), `engram-log-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const db = openMemoryDb(path.join(dir, "memory.db"))
    const cfg = {
      ...defaultEngramConfig.telemetry,
      minLevel: "info" as const,
      detailMaxLength: 24,
    }
    const logger = new EngramLogger(db, "p1", cfg)
    const now = Date.now()

    logger.debug("startup", "debug_skipped", { secret: "not recorded" })
    logger.info("startup", "runtime_created", { long: "x".repeat(100) })
    logger.error("embedding", "embed_failed", new Error("boom"), { batch: 3 })
    recordLogEvent(db, cfg, {
      projectId: "p1",
      level: "warn",
      category: "archive",
      event: "verify_failed",
      message: "hash mismatch",
      timeCreated: now - 3 * 86400000,
    })

    let rows = recentLogEvents(db, "p1", { limit: 10 })
    expect(rows.map((r) => r.event)).not.toContain("debug_skipped")
    expect(rows.length).toBe(3)
    expect(rows.find((r) => r.event === "runtime_created")?.detail?.length).toBeLessThanOrEqual(24)
    expect(formatEventReport(rows)).toContain("embed_failed")

    pruneLogEvents(db, "p1", 1, now)
    rows = recentLogEvents(db, "p1", { limit: 10 })
    expect(rows.map((r) => r.event)).not.toContain("verify_failed")

    logger.warn("archive", "one", undefined)
    logger.warn("archive", "two", undefined)
    trimLogEvents(db, "p1", 2)
    expect(recentLogEvents(db, "p1", { limit: 10 })).toHaveLength(2)

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

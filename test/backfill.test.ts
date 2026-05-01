import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { backfillDone, backfillFromHot, markBackfillProgress } from "../src/backfill.ts"
import { defaultEngramConfig } from "../src/config.ts"
import { applyConnPragmas, openMemoryDb } from "../src/db.ts"

describe("backfillFromHot", () => {
  test("skips malformed hot rows and commits progress after durable caller step", () => {
    const dir = path.join(os.tmpdir(), `engram-backfill-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const hotPath = path.join(dir, "hot.db")
    const memPath = path.join(dir, "memory.db")

    const hot = new Database(hotPath, { create: true })
    applyConnPragmas(hot)
    hot.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `)
    hot.prepare(`INSERT INTO session (id, project_id) VALUES (?, ?)`).run("s1", "proj1")
    const now = Date.now()
    hot
      .prepare(`INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)`)
      .run("m_bad", "s1", JSON.stringify({ role: "assistant" }))
    hot
      .prepare(`INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)`)
      .run("p_bad", "m_bad", "s1", now, "{not-json")
    hot
      .prepare(`INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)`)
      .run("m_ok", "s1", JSON.stringify({ role: "assistant", agent: "executor", modelID: "m" }))
    hot
      .prepare(`INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)`)
      .run("p_ok", "m_ok", "s1", now + 1, JSON.stringify({ type: "text", text: "remember me" }))

    const memory = openMemoryDb(memPath)
    const result = backfillFromHot({
      hot,
      memory,
      projectId: "proj1",
      cfg: defaultEngramConfig,
      batchLimit: 10,
    })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.content).toBe("remember me")
    expect(result.done).toBe(true)
    expect(backfillDone(memory)).toBe(false)

    markBackfillProgress(memory, result)
    expect(backfillDone(memory)).toBe(true)

    hot.close()
    memory.close()
    rmSync(dir, { recursive: true })
  })
})

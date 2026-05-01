import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { Database } from "bun:sqlite"
import {
  exportRootSession,
  importArchiveToMemory,
  inspectArchive,
  restoreArchiveToHot,
  searchArchive,
  verifyArchiveFile,
} from "../src/archive.ts"
import { defaultEngramConfig, expandArchivePath } from "../src/config.ts"
import { applyConnPragmas, openMemoryDb } from "../src/db.ts"

describe("archive export", () => {
  test("writes gzip and idempotent hash skip", async () => {
    const dir = path.join(os.tmpdir(), `engram-arch-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const hotPath = path.join(dir, "hot.db")
    const memPath = path.join(dir, "mem.db")

    const hot = new Database(hotPath, { create: true })
    applyConnPragmas(hot)
    hot.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `)
    hot
      .prepare(`INSERT INTO session (id, project_id, parent_id, time_created, time_updated) VALUES (?,?,?,?,?)`)
      .run("root1", "proj1", null, 1, 1)
    hot
      .prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)`)
      .run("m1", "root1", 2, JSON.stringify({ role: "user" }))
    hot
      .prepare(`INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)`)
      .run("p1", "m1", "root1", 3, JSON.stringify({ type: "text", text: "hi" }))
    hot.close()

    const memoryDb = openMemoryDb(memPath)
    const cfg = {
      ...defaultEngramConfig,
      archive: {
        ...defaultEngramConfig.archive,
        exportTimeoutMs: 60_000,
        path: path.join(dir, "ar"),
      },
    }
    const home = dir
    const archiveRoot = expandArchivePath(home, cfg.archive)
    mkdirSync(archiveRoot, { recursive: true })

    const r1 = await exportRootSession({
      memoryDb,
      hotPath,
      projectId: "proj1",
      rootSessionId: "root1",
      cfg,
      home,
      force: false,
    })
    expect(r1.skipped).toBe(false)
    const gz = path.join(archiveRoot, "proj1", "root1.jsonl.gz")
    const buf = readFileSync(gz)
    expect(buf.length).toBeGreaterThan(8)

    const r2 = await exportRootSession({
      memoryDb,
      hotPath,
      projectId: "proj1",
      rootSessionId: "root1",
      cfg,
      home,
      force: false,
    })
    expect(r2.skipped).toBe(true)

    const hot2 = new Database(hotPath)
    applyConnPragmas(hot2)
    const updated = Date.now() + 1
    hot2.prepare(`UPDATE session SET time_updated = ? WHERE id = ?`).run(updated, "root1")
    hot2
      .prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)`)
      .run("m2", "root1", updated, JSON.stringify({ role: "assistant" }))
    hot2
      .prepare(`INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)`)
      .run("p2", "m2", "root1", updated, JSON.stringify({ type: "text", text: "new hot data" }))
    hot2.close()

    const r3 = await exportRootSession({
      memoryDb,
      hotPath,
      projectId: "proj1",
      rootSessionId: "root1",
      cfg,
      home,
      force: false,
    })
    expect(r3.skipped).toBe(false)
    const row = memoryDb
      .query(`SELECT message_count, part_count FROM archive WHERE root_session_id = ? AND project_id = ?`)
      .get("root1", "proj1") as { message_count: number; part_count: number }
    expect(row.message_count).toBe(2)
    expect(row.part_count).toBe(2)

    const ok = await verifyArchiveFile({
      memoryDb,
      archiveRoot,
      projectId: "proj1",
      rootSessionId: "root1",
    })
    expect(ok.ok).toBe(true)

    const inspected = await inspectArchive({
      memoryDb,
      archiveRoot,
      projectId: "proj1",
      rootSessionId: "root1",
    })
    expect(inspected).toEqual({ sessions: 1, messages: 2, parts: 2 })

    const matches = await searchArchive({
      memoryDb,
      archiveRoot,
      projectId: "proj1",
      rootSessionId: "root1",
      query: "new hot data",
      limit: 5,
    })
    expect(matches.length).toBe(1)

    const restoreHotPath = path.join(dir, "restore-hot.db")
    const restoreHot = new Database(restoreHotPath, { create: true })
    applyConnPragmas(restoreHot)
    restoreHot.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    `)
    restoreHot.close()
    const restored = await restoreArchiveToHot({
      memoryDb,
      archiveRoot,
      hotPath: restoreHotPath,
      projectId: "proj1",
      rootSessionId: "root1",
      dryRun: false,
    })
    expect(restored).toEqual({ sessions: 1, messages: 2, parts: 2, applied: true })
    const restoredDb = new Database(restoreHotPath)
    const restoredMessages = restoredDb.query(`SELECT count(*) AS c FROM message`).get() as {
      c: number
    }
    restoredDb.close()
    expect(restoredMessages.c).toBe(2)

    const imported = await importArchiveToMemory({
      memoryDb,
      archiveRoot,
      projectId: "proj1",
      rootSessionId: "root1",
      cfg,
    })
    expect(imported.inserted).toBe(1)
    const importedChunk = memoryDb.query(`SELECT content FROM chunk WHERE project_id = ?`).get("proj1") as
      | { content: string }
      | undefined
    expect(importedChunk?.content).toBe("new hot data")

    writeFileSync(gz, "corrupted")
    const bad = await verifyArchiveFile({
      memoryDb,
      archiveRoot,
      projectId: "proj1",
      rootSessionId: "root1",
    })
    expect(bad.ok).toBe(false)

    memoryDb.close()
    unlinkSync(hotPath)
    unlinkSync(restoreHotPath)
    unlinkSync(memPath)
    unlinkSync(gz)
  })
})

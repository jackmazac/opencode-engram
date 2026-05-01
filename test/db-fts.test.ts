import { describe, expect, test } from "bun:test"
import { mkdirSync, unlinkSync } from "node:fs"
import path from "node:path"
import { openMemoryDb } from "../src/db.ts"
import { ulid } from "ulid"

describe("migrations and FTS", () => {
  test("migrate twice reaches stable user_version", () => {
    const dir = path.join("/tmp", `engram-fts-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const p = path.join(dir, "memory.db")
    const d1 = openMemoryDb(p)
    const v1 = Number((d1.query("PRAGMA user_version;").get() as { user_version: number }).user_version)
    d1.close()
    const d2 = openMemoryDb(p)
    const v2 = Number((d2.query("PRAGMA user_version;").get() as { user_version: number }).user_version)
    const cols = d2.query(`PRAGMA table_info(chunk)`).all() as { name: string }[]
    const logCols = d2.query(`PRAGMA table_info(log_event)`).all() as { name: string }[]
    expect(v1).toBe(v2)
    expect(v2).toBe(12)
    expect(cols.map((c) => c.name)).toContain("embedding_model")
    expect(cols.map((c) => c.name)).toContain("embedding_dimensions")
    expect(cols.map((c) => c.name)).toContain("source_kind")
    expect(cols.map((c) => c.name)).toContain("authority")
    expect(logCols.map((c) => c.name)).toContain("category")
    d2.close()
    unlinkSync(p)
  })

  test("export checkpoints are scoped by project and root session", () => {
    const dir = path.join("/tmp", `engram-ck-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const p = path.join(dir, "memory.db")
    const db = openMemoryDb(p)
    const ins = db.prepare(
      `INSERT INTO export_checkpoint (
        root_session_id, project_id, exported_message_id, exported_part_id, exported_count, total_count, phase, updated_at
      ) VALUES (?,?,?,?,?,?,?,?)`,
    )

    ins.run("root", "proj1", null, null, 1, 2, "messages", 1)
    ins.run("root", "proj2", null, null, 3, 4, "parts", 2)

    const rows = db
      .query(`SELECT project_id, exported_count FROM export_checkpoint WHERE root_session_id = ? ORDER BY project_id`)
      .all("root") as { project_id: string; exported_count: number }[]
    expect(rows).toEqual([
      { project_id: "proj1", exported_count: 1 },
      { project_id: "proj2", exported_count: 3 },
    ])

    db.close()
    unlinkSync(p)
  })

  test("external FTS row tracks chunk", () => {
    const dir = path.join("/tmp", `engram-fts2-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const p = path.join(dir, "memory.db")
    const db = openMemoryDb(p)
    const id = ulid()
    db.prepare(
      `INSERT INTO chunk (
        id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
        file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
        time_created, content_hash, root_session_id, session_depth, plan_slug
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      "s1",
      "m1",
      null,
      "p1",
      "assistant",
      null,
      null,
      "plan",
      "hello fts unique xyz",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      Date.now(),
      "h1",
      "s1",
      0,
      null,
    )
    const hit = db.query(`SELECT chunk_id FROM chunk_fts WHERE chunk_fts MATCH ?`).get("xyz") as
      | { chunk_id: string }
      | undefined
    expect(hit?.chunk_id).toBe(id)

    db.prepare(`DELETE FROM chunk WHERE id = ?`).run(id)
    const gone = db.query(`SELECT chunk_id FROM chunk_fts WHERE chunk_id = ?`).get(id)
    expect(gone).toBeNull()
    db.close()
    unlinkSync(p)
  })
})

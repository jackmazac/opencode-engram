import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { ingestArtifacts } from "../src/artifacts.ts"
import { buildContextBundle, formatContextBundle } from "../src/context.ts"
import { defaultEngramConfig } from "../src/config.ts"
import { distillRoots } from "../src/distill.ts"
import { backfillHot } from "../src/hot-backfill.ts"
import { buildMemoryRelations } from "../src/relations.ts"
import { indexHotRoots } from "../src/root-index.ts"
import { openMemoryDb } from "../src/db.ts"

describe("learning modules", () => {
  test("ingests artifacts and builds preflight context", () => {
    const dir = path.join(os.tmpdir(), `engram-learning-artifacts-${Date.now()}`)
    mkdirSync(path.join(dir, ".opencode", "plans"), { recursive: true })
    writeFileSync(
      path.join(dir, ".opencode", "journal.jsonl"),
      `${JSON.stringify({ type: "decision", content: "Decision: backfill cursor advances only after durable insert." })}\n`,
    )
    writeFileSync(path.join(dir, ".opencode", "plans", "durable-backfill.md"), "# Durable Backfill\nPlan body")
    const db = openMemoryDb(path.join(dir, "memory.db"))

    const dry = ingestArtifacts({
      db,
      worktree: dir,
      projectId: "p1",
      cfg: defaultEngramConfig,
      dryRun: true,
    })
    expect(dry.items).toBe(2)
    expect(dry.chunksInserted).toBe(0)

    const applied = ingestArtifacts({
      db,
      worktree: dir,
      projectId: "p1",
      cfg: defaultEngramConfig,
      dryRun: false,
    })
    expect(applied.chunksInserted).toBe(2)
    const chunks = db.prepare(`SELECT content_type, authority FROM chunk WHERE project_id = ?`).all("p1") as {
      content_type: string
      authority: number
    }[]
    expect(chunks.map((c) => c.content_type).sort()).toEqual(["decision", "plan"])
    expect(Math.max(...chunks.map((c) => c.authority))).toBe(10)

    const bundle = buildContextBundle({
      db,
      projectId: "p1",
      query: "durable insert",
      mode: "plan",
      limit: 5,
    })
    const formatted = formatContextBundle(bundle)
    expect(formatted).toContain("Must Know")
    expect(formatted).toContain("backfill cursor")
    expect(formatted).toContain("why:")

    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("indexes hot roots, backfills signals, distills, and builds relations", () => {
    const dir = path.join(os.tmpdir(), `engram-learning-hot-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const memory = openMemoryDb(path.join(dir, "memory.db"))
    const hotPath = path.join(dir, "hot.db")
    const hot = new Database(hotPath, { create: true })
    hot.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        title TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    `)
    const now = Date.now()
    hot
      .prepare(
        `INSERT INTO session (id, project_id, parent_id, title, time_created, time_updated) VALUES (?,?,?,?,?,?)`,
      )
      .run("root1", "p1", null, "Plan Durable Backfill Audit", now, now + 10)
    hot
      .prepare(
        `INSERT INTO session (id, project_id, parent_id, title, time_created, time_updated) VALUES (?,?,?,?,?,?)`,
      )
      .run("child1", "p1", "root1", "Fix Durable Backfill", now + 1, now + 11)
    hot
      .prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)`)
      .run("m1", "child1", now + 2, JSON.stringify({ role: "assistant", agent: "reviewer" }))
    hot.prepare(`INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)`).run(
      "p_text",
      "m1",
      "child1",
      now + 3,
      JSON.stringify({
        type: "text",
        text: "Reviewer finding: durable backfill must not advance before insert.",
      }),
    )
    hot
      .prepare(`INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)`)
      .run("p_patch", "m1", "child1", now + 4, JSON.stringify({ type: "patch" }))
    hot.prepare(`INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)`).run(
      "p_read",
      "m1",
      "child1",
      now + 5,
      JSON.stringify({
        type: "tool",
        tool: "read",
        state: { status: "completed", output: "large low value output" },
      }),
    )
    hot.close()

    const indexed = indexHotRoots({ db: memory, hotPath, projectId: "p1", dryRun: false })
    expect(indexed.indexed).toBe(1)
    expect(indexed.top[0]?.score).toBeGreaterThan(0)

    const backfilled = backfillHot({
      db: memory,
      hotPath,
      projectId: "p1",
      cfg: defaultEngramConfig,
      strategy: "priority",
      dryRun: false,
      maxRoots: 5,
      maxParts: 10,
    })
    expect(backfilled.chunksInserted).toBeGreaterThan(0)
    const readTrace = memory
      .prepare(`SELECT count(*) AS n FROM chunk WHERE project_id = ? AND source_ref LIKE ?`)
      .get("p1", "%p_read%") as { n: number }
    expect(readTrace.n).toBe(0)

    const distilled = distillRoots({
      db: memory,
      projectId: "p1",
      cfg: defaultEngramConfig,
      top: 1,
      dryRun: false,
    })
    expect(distilled.chunksInserted).toBe(1)

    const insertPlan = memory.prepare(
      `INSERT INTO chunk (
        id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
        file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
        time_created, content_hash, root_session_id, session_depth, plan_slug, source_kind, source_ref, authority
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    insertPlan.run(
      "old-plan",
      "s",
      "m-old",
      null,
      "p1",
      "assistant",
      null,
      null,
      "plan",
      "Old durable backfill plan",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      now,
      "old-hash",
      "root1",
      0,
      "durable-backfill",
      "plan",
      "plan:old",
      8,
    )
    insertPlan.run(
      "new-plan",
      "s",
      "m-new",
      null,
      "p1",
      "assistant",
      null,
      null,
      "plan",
      "New durable backfill plan",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      now + 100,
      "new-hash",
      "root1",
      0,
      "durable-backfill",
      "plan",
      "plan:new",
      8,
    )
    const relations = buildMemoryRelations({ db: memory, projectId: "p1", dryRun: false, max: 10 })
    expect(relations.superseded).toBeGreaterThan(0)
    const old = memory.prepare(`SELECT superseded_by FROM chunk WHERE id = ?`).get("old-plan") as {
      superseded_by: string | null
    }
    expect(old.superseded_by).toBe("new-plan")

    memory.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

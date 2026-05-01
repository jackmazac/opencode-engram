import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { applyClassifyItems, parseClassifyJsonLine } from "../src/classify.ts"
import { defaultEngramConfig } from "../src/config.ts"
import { openMemoryDb } from "../src/db.ts"

describe("parseClassifyJsonLine", () => {
  test("valid line", () => {
    const r = parseClassifyJsonLine('{"id":"01","type":"plan","confidence":0.8}')
    expect(r).toEqual({ id: "01", type: "plan", confidence: 0.8 })
  })

  test("malformed json", () => {
    expect(parseClassifyJsonLine("{not json")).toBeUndefined()
  })

  test("non-object", () => {
    expect(parseClassifyJsonLine('"x"')).toBeUndefined()
  })
})

describe("applyClassifyItems", () => {
  test("uses confidence threshold before changing chunk type", () => {
    const dir = path.join(os.tmpdir(), `engram-classify-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const db = openMemoryDb(path.join(dir, "memory.db"))
    const cfg = {
      ...defaultEngramConfig,
      classify: {
        ...defaultEngramConfig.classify,
        typeProposalThreshold: 50,
      },
    }

    db.prepare(
      `INSERT INTO chunk (
        id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
        file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
        time_created, content_hash, root_session_id, session_depth, plan_slug
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "c1",
      "s1",
      "m1",
      null,
      "proj1",
      "assistant",
      null,
      null,
      "discovery",
      "content",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      Date.now(),
      "hash1",
      "s1",
      0,
      null,
    )

    applyClassifyItems(db, cfg, {
      items: [{ id: "c1", type: "decision", confidence: 0.4 }],
    })
    const low = db.query(`SELECT content_type FROM chunk WHERE id = ?`).get("c1") as {
      content_type: string
    }
    expect(low.content_type).toBe("discovery")
    const proposal = db.query(`SELECT proposed_type, confidence FROM type_proposal WHERE chunk_id = ?`).get("c1") as {
      proposed_type: string
      confidence: number
    }
    expect(proposal.proposed_type).toBe("decision")
    expect(proposal.confidence).toBe(0.4)

    applyClassifyItems(db, cfg, {
      items: [{ id: "c1", type: "decision", confidence: 0.8 }],
    })
    const high = db.query(`SELECT content_type FROM chunk WHERE id = ?`).get("c1") as {
      content_type: string
    }
    expect(high.content_type).toBe("decision")

    db.close()
    rmSync(dir, { recursive: true })
  })
})

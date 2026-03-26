/**
 * Performance checks: real SQLite + Engram schema, real cosine/RRF helpers (no mocks, no network).
 * Budgets are loose so CI / slow disks pass; tighten locally to catch regressions.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import type { Database } from "bun:sqlite"
import { defaultEngramConfig } from "../src/config.ts"
import { topKByCosine } from "../src/cosine.ts"
import { openMemoryDb } from "../src/db.ts"
import { rrfMerge } from "../src/rrf.ts"

const dim = defaultEngramConfig.sidecar.dimensions
const rowN = 1200

/** L2-normalized embedding blob for stable cosine math (deterministic per index). */
function normBlob(i: number, d: number): Buffer {
  const f = new Float32Array(d)
  for (let k = 0; k < d; k++) {
    f[k] = Math.sin(i * 0.03 + k * 0.07)
  }
  let s = 0
  for (let k = 0; k < d; k++) {
    const x = f[k] ?? 0
    s += x * x
  }
  s = Math.sqrt(s) || 1
  for (let k = 0; k < d; k++) {
    f[k] = (f[k] ?? 0) / s
  }
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength)
}

/** Bun `bun:sqlite` may return BLOB as Buffer or Uint8Array — normalize for `topKByCosine`. */
function asBuf(x: Buffer | Uint8Array | null | undefined): Buffer | null {
  if (x == null) return null
  if (Buffer.isBuffer(x)) return x
  return Buffer.from(x.buffer, x.byteOffset, x.byteLength)
}

function seedProject(db: Database, pid: string, n: number, d: number) {
  const ins = db.prepare(
    `INSERT INTO chunk (
      id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
      file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
      embedding, time_created, time_embedded, content_hash, root_session_id, session_depth, plan_slug
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  const now = Date.now()
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const id = `perf${i.toString(36).padStart(5, "0")}`
      ins.run(
        id,
        `sess${i % 40}`,
        `msg${i}`,
        null,
        pid,
        "assistant",
        null,
        null,
        "synthesis",
        `perftest tokenqwerty decision analysis ${i}\n${"word ".repeat(20)}`,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        normBlob(i, d),
        now + i,
        now + i,
        `hash${i}`,
        "root1",
        0,
        null,
      )
    }
  })
  tx()
}

describe("perf operations (real db)", () => {
  test("bulk seed, FTS, vector scan + topK, stats-shaped queries stay within budget", () => {
    const dir = path.join(os.tmpdir(), `engram-perf-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const dbPath = path.join(dir, "memory.db")
    const db = openMemoryDb(dbPath)
    const pid = "perf-proj"
    const kFts = defaultEngramConfig.memorySearch.kFts
    const kVec = defaultEngramConfig.memorySearch.kVec

    const t0 = performance.now()
    seedProject(db, pid, rowN, dim)
    const seedMs = performance.now() - t0
    expect(seedMs).toBeLessThan(12_000)

    const matchStr = `"tokenqwerty"`
    const ftsSql = `SELECT chunk_fts.chunk_id AS id
       FROM chunk_fts
       INNER JOIN chunk c ON c.id = chunk_fts.chunk_id
       WHERE chunk_fts MATCH ? AND c.project_id = ? AND (1)
       ORDER BY rank
       LIMIT ?`
    const fts = db.prepare(ftsSql)
    const tFts0 = performance.now()
    const ftsRows = fts.all(matchStr, pid, kFts) as { id: string }[]
    const ftsEnd = performance.now() - tFts0
    expect(ftsRows.length).toBeGreaterThan(0)
    expect(ftsEnd).toBeLessThan(3000)

    const vecSql = `SELECT c.id, c.embedding AS embedding
       FROM chunk c
       WHERE c.project_id = ? AND c.embedding IS NOT NULL AND (1)`
    const tVec0 = performance.now()
    const rawEmb = db.prepare(vecSql).all(pid) as { id: string; embedding: Buffer | Uint8Array | null }[]
    expect(rawEmb.length).toBe(rowN)
    const embRows = rawEmb.flatMap((r) => {
      const b = asBuf(r.embedding)
      if (b == null || b.byteLength < dim * 4) return []
      return [{ id: r.id, blob: b }]
    })
    expect(embRows.length).toBe(rowN)
    const q = normBlob(999, dim)
    const qv = new Float32Array(q.buffer, q.byteOffset, q.byteLength / 4)
    const top = topKByCosine(qv, embRows, kVec)
    const vecMs = performance.now() - tVec0
    expect(top.length).toBe(kVec)
    expect(vecMs).toBeLessThan(5000)

    const ov = db
      .prepare(
        `SELECT count(*) AS total, sum(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS emb
         FROM chunk WHERE project_id = ?`,
      )
      .get(pid) as { total: number; emb: number }
    const byType = db
      .prepare(`SELECT content_type, count(*) AS n FROM chunk WHERE project_id = ? GROUP BY content_type`)
      .all(pid) as { content_type: string; n: number }[]
    expect(ov.total).toBe(rowN)
    expect(ov.emb).toBe(rowN)
    expect(byType.length).toBeGreaterThan(0)

    db.close()
    rmSync(dir, { recursive: true })
  })
})

describe("perf helpers (cpu)", () => {
  test("rrfMerge on ranked lists", () => {
    const a = Array.from({ length: 50 }, (_, i) => `id${i}`)
    const b = Array.from({ length: 30 }, (_, i) => `id${i + 25}`)
    const t0 = performance.now()
    const m = rrfMerge([a, b])
    const ms = performance.now() - t0
    expect(m.length).toBeGreaterThan(40)
    expect(ms).toBeLessThan(100)
  })

  test("topKByCosine with in-memory rows only", () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ id: `r${i}`, blob: normBlob(i, dim) }))
    const q = new Float32Array(dim)
    q[0] = 1
    let sq = 0
    for (let i = 1; i < dim; i++) {
      const t = Math.sin(i) * 0.01
      q[i] = t
      sq += t * t
    }
    const n = Math.sqrt(1 + sq) || 1
    for (let i = 0; i < dim; i++) {
      q[i] = (q[i] ?? 0) / n
    }
    const t0 = performance.now()
    const k = topKByCosine(q, rows, 30)
    const ms = performance.now() - t0
    expect(k).toHaveLength(30)
    expect(ms).toBeLessThan(2000)
  })
})

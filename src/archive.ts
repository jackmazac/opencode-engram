import { createHash } from "node:crypto"
import { createReadStream, createWriteStream, existsSync, promises as fsp, readFileSync, unlinkSync } from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { createGzip } from "node:zlib"
import { Database } from "bun:sqlite"
import { ulid } from "ulid"
import type { EngramConfig } from "./config.ts"
import { expandArchivePath } from "./config.ts"
import { applyConnPragmas } from "./db.ts"

export type ExportOpts = {
  memoryDb: Database
  hotPath: string
  projectId: string
  rootSessionId: string
  cfg: EngramConfig
  home: string
  force: boolean
  onProgress?: (line: string) => void
}

function notify(opts: ExportOpts, msg: string) {
  opts.onProgress?.(msg)
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex")
}

/** All session ids in subtree of root (includes root). Opens short-lived RO connection. */
export function treeSessionIds(hotPath: string, projectId: string, rootId: string): string[] {
  const db = new Database(hotPath, { readonly: true })
  applyConnPragmas(db)
  const rows = db
    .query(
      `WITH RECURSIVE t AS (
         SELECT id FROM session WHERE id = ? AND project_id = ?
         UNION ALL
         SELECT s.id FROM session s INNER JOIN t ON s.parent_id = t.id
       )
       SELECT id FROM t`,
    )
    .all(rootId, projectId) as { id: string }[]
  db.close()
  return rows.map((r) => r.id)
}

function subtreeMaxUpdated(hotPath: string, projectId: string, rootId: string): number {
  const db = new Database(hotPath, { readonly: true })
  applyConnPragmas(db)
  const row = db
    .query(
      `WITH RECURSIVE t AS (
         SELECT id, time_updated FROM session WHERE id = ? AND project_id = ?
         UNION ALL
         SELECT s.id, s.time_updated FROM session s INNER JOIN t ON s.parent_id = t.id
       )
       SELECT max(time_updated) AS m FROM t`,
    )
    .get(rootId, projectId) as { m: number | null } | undefined
  db.close()
  return Number(row?.m ?? 0)
}

export function listRootSessionIds(hotPath: string, projectId: string): string[] {
  const db = new Database(hotPath, { readonly: true })
  applyConnPragmas(db)
  const rows = db
    .query(`SELECT id FROM session WHERE project_id = ? AND parent_id IS NULL`)
    .all(projectId) as { id: string }[]
  db.close()
  return rows.map((r) => r.id)
}

export function staleRootIds(
  hotPath: string,
  projectId: string,
  staleDays: number,
  now: number,
): string[] {
  const cutoff = now - staleDays * 86400000
  const roots = listRootSessionIds(hotPath, projectId)
  return roots.filter((id) => subtreeMaxUpdated(hotPath, projectId, id) < cutoff)
}

type Ck = {
  exported_message_id: string | null
  exported_part_id: string | null
  exported_count: number
  total_count: number | null
  phase: string
}

function upsertCheckpoint(
  memoryDb: Database,
  pid: string,
  root: string,
  phase: string,
  msgCursor: string | null,
  partCursor: string | null,
  count: number,
  total: number,
) {
  memoryDb
    .prepare(
      `INSERT INTO export_checkpoint (root_session_id, project_id, exported_message_id, exported_part_id, exported_count, total_count, phase, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(root_session_id) DO UPDATE SET
         exported_message_id = excluded.exported_message_id,
         exported_part_id = excluded.exported_part_id,
         exported_count = excluded.exported_count,
         total_count = excluded.total_count,
         phase = excluded.phase,
         updated_at = excluded.updated_at`,
    )
    .run(root, pid, msgCursor, partCursor, count, total, phase, Date.now())
}

export async function exportRootSession(opts: ExportOpts): Promise<{ skipped: boolean; path?: string }> {
  const { memoryDb, hotPath, projectId, rootSessionId, cfg, home, force } = opts
  const archiveRoot = expandArchivePath(home, cfg.archive)
  const rel = path.join(projectId, `${rootSessionId}.jsonl.gz`)
  const outAbs = path.join(archiveRoot, rel)
  const tmpAbs = path.join(archiveRoot, projectId, `${rootSessionId}.jsonl.tmp`)

  await fsp.mkdir(path.dirname(outAbs), { recursive: true })

  const existing = memoryDb
    .query(`SELECT content_hash, archive_path FROM archive WHERE root_session_id = ? AND project_id = ?`)
    .get(rootSessionId, projectId) as { content_hash: string; archive_path: string } | undefined

  const existingAbs = existing ? path.join(archiveRoot, existing.archive_path) : ""

  if (!force && existing && existsSync(existingAbs)) {
    const buf = readFileSync(existingAbs)
    const h = sha256Hex(buf)
    if (h === existing.content_hash) {
      notify(opts, `Skip ${rootSessionId}: archive up to date`)
      return { skipped: true, path: existing.archive_path }
    }
  }

  const tree = treeSessionIds(hotPath, projectId, rootSessionId)
  if (tree.length === 0) {
    notify(opts, `No session tree for ${rootSessionId}`)
    return { skipped: true }
  }

  const placeholders = tree.map(() => "?").join(",")
  const treeArgs = tree

  const countSessions = () => tree.length

  const openRo = () => {
    const x = new Database(hotPath, { readonly: true })
    applyConnPragmas(x)
    return x
  }

  let ro = openRo()
  const msgCount =
    (
      ro.prepare(
        `SELECT count(*) AS c FROM message WHERE session_id IN (${placeholders})`,
      ).get(...treeArgs) as { c: number }
    ).c ?? 0
  const partCount =
    (
      ro.prepare(`SELECT count(*) AS c FROM part WHERE session_id IN (${placeholders})`).get(...treeArgs) as {
        c: number
      }
    ).c ?? 0
  ro.close()

  if (force) {
    memoryDb.prepare(`DELETE FROM export_checkpoint WHERE root_session_id = ?`).run(rootSessionId)
    if (existsSync(tmpAbs)) unlinkSync(tmpAbs)
  }

  const ckRow = force
    ? undefined
    : (memoryDb.query(`SELECT * FROM export_checkpoint WHERE root_session_id = ?`).get(rootSessionId) as Ck | undefined)

  const deadline = Date.now() + cfg.archive.exportTimeoutMs
  const batch = cfg.archive.batchSize

  const writeLine = async (line: string) => {
    await fsp.appendFile(tmpAbs, `${line}\n`, "utf8")
  }

  const skipMessages = !force && ckRow?.phase === "parts"
  let lastMsgId = ""
  let exportedMsgs = 0
  if (!force && ckRow?.phase === "messages") {
    lastMsgId = ckRow.exported_message_id ?? ""
    exportedMsgs = ckRow.exported_count
  }

  if (!skipMessages) {
    upsertCheckpoint(memoryDb, projectId, rootSessionId, "messages", lastMsgId || null, null, exportedMsgs, msgCount)

    while (true) {
      if (Date.now() > deadline) {
        notify(opts, `Checkpoint ${rootSessionId}: messages ${exportedMsgs}/${msgCount}`)
        upsertCheckpoint(
          memoryDb,
          projectId,
          rootSessionId,
          "messages",
          lastMsgId || null,
          null,
          exportedMsgs,
          msgCount,
        )
        return { skipped: false, path: rel }
      }

      ro = openRo()
      const rows = ro
        .prepare(
          `SELECT id, session_id, time_created, data FROM message
         WHERE session_id IN (${placeholders}) AND id > ?
         ORDER BY id LIMIT ?`,
        )
        .all(...treeArgs, lastMsgId, batch) as { id: string; session_id: string; time_created: number; data: string }[]
      ro.close()

      if (rows.length === 0) break

      for (const r of rows) {
        const rec = {
          kind: "message" as const,
          id: r.id,
          session_id: r.session_id,
          time_created: r.time_created,
          data: JSON.parse(r.data) as unknown,
        }
        await writeLine(JSON.stringify(rec))
        lastMsgId = r.id
        exportedMsgs++
      }

      notify(opts, `Exporting ${rootSessionId}: ${exportedMsgs}/${msgCount} messages`)
      await new Promise((r) => setImmediate(r))
    }
  }

  let lastPartId = ""
  let exportedParts = 0
  if (!force && ckRow?.phase === "parts") {
    lastPartId = ckRow.exported_part_id ?? ""
    exportedParts = ckRow.exported_count
  }

  upsertCheckpoint(memoryDb, projectId, rootSessionId, "parts", lastMsgId || null, lastPartId || null, exportedParts, partCount)

  while (true) {
    if (Date.now() > deadline) {
      upsertCheckpoint(
        memoryDb,
        projectId,
        rootSessionId,
        "parts",
        lastMsgId || null,
        lastPartId || null,
        exportedParts,
        partCount,
      )
      notify(opts, `Checkpoint ${rootSessionId}: parts ${exportedParts}/${partCount}`)
      return { skipped: false, path: rel }
    }

    ro = openRo()
    const rows = ro
      .prepare(
        `SELECT id, message_id, session_id, time_created, data FROM part
         WHERE session_id IN (${placeholders}) AND id > ?
         ORDER BY id LIMIT ?`,
      )
      .all(...treeArgs, lastPartId, batch) as {
      id: string
      message_id: string
      session_id: string
      time_created: number
      data: string
    }[]
    ro.close()

    if (rows.length === 0) break

    for (const r of rows) {
      const rec = {
        kind: "part" as const,
        id: r.id,
        message_id: r.message_id,
        session_id: r.session_id,
        time_created: r.time_created,
        data: JSON.parse(r.data) as unknown,
      }
      await writeLine(JSON.stringify(rec))
      lastPartId = r.id
      exportedParts++
    }

    notify(opts, `Exporting ${rootSessionId}: ${exportedParts}/${partCount} parts`)
    await new Promise((r) => setImmediate(r))
  }

  if (!existsSync(tmpAbs)) {
    notify(opts, `Nothing to export for ${rootSessionId}`)
    memoryDb.prepare(`DELETE FROM export_checkpoint WHERE root_session_id = ?`).run(rootSessionId)
    return { skipped: true }
  }

  await pipeline(createReadStream(tmpAbs), createGzip(), createWriteStream(outAbs))
  unlinkSync(tmpAbs)

  const outBuf = readFileSync(outAbs)
  const hash = sha256Hex(outBuf)
  const relOut = path.join(projectId, `${rootSessionId}.jsonl.gz`)

  if (existing && !force && existing.content_hash === hash) {
    notify(opts, `Skip ${rootSessionId}: identical hash`)
    return { skipped: true, path: relOut }
  }

  memoryDb.prepare(`DELETE FROM archive WHERE root_session_id = ? AND project_id = ?`).run(rootSessionId, projectId)

  const archiveId = ulid()
  memoryDb
    .prepare(
      `INSERT INTO archive (id, root_session_id, project_id, session_count, message_count, part_count, archive_path, archive_size, content_hash, time_created)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      archiveId,
      rootSessionId,
      projectId,
      countSessions(),
      msgCount,
      partCount,
      relOut,
      outBuf.length,
      hash,
      Date.now(),
    )

  memoryDb.prepare(`DELETE FROM export_checkpoint WHERE root_session_id = ?`).run(rootSessionId)

  notify(opts, `Wrote ${relOut} (${outBuf.length} bytes)`)
  return { skipped: false, path: relOut }
}

export function listArchiveRows(memoryDb: Database, projectId: string) {
  return memoryDb
    .query(
      `SELECT root_session_id, message_count, part_count, archive_path, content_hash, time_created FROM archive WHERE project_id = ? ORDER BY time_created DESC`,
    )
    .all(projectId) as {
    root_session_id: string
    message_count: number
    part_count: number
    archive_path: string
    content_hash: string
    time_created: number
  }[]
}

export function verifyArchiveFile(opts: {
  memoryDb: Database
  archiveRoot: string
  projectId: string
  rootSessionId: string
}): { ok: boolean; detail: string } {
  const row = opts.memoryDb
    .query(`SELECT content_hash, archive_path FROM archive WHERE root_session_id = ? AND project_id = ?`)
    .get(opts.rootSessionId, opts.projectId) as { content_hash: string; archive_path: string } | undefined
  if (!row) return { ok: false, detail: "No archive row" }
  const abs = path.join(opts.archiveRoot, row.archive_path)
  if (!existsSync(abs)) return { ok: false, detail: `Missing file ${abs}` }
  const buf = readFileSync(abs)
  const h = sha256Hex(buf)
  if (h !== row.content_hash) return { ok: false, detail: `Hash mismatch file=${h} row=${row.content_hash}` }
  return { ok: true, detail: "OK" }
}

export type DeleteOpts = {
  hotPath: string
  projectId: string
  rootSessionId: string
  vacuum: boolean
}

/** Delete session subtree from hot DB (destructive). Caller confirms. */
export function deleteSubtreeFromHot(opts: DeleteOpts) {
  const { hotPath, projectId, rootSessionId, vacuum } = opts
  const hot = new Database(hotPath)
  applyConnPragmas(hot)
  const tree = hot
    .query(
      `WITH RECURSIVE t AS (
         SELECT id, parent_id FROM session WHERE id = ? AND project_id = ?
         UNION ALL
         SELECT s.id, s.parent_id FROM session s INNER JOIN t ON s.parent_id = t.id
       )
       SELECT id, parent_id FROM t`,
    )
    .all(rootSessionId, projectId) as { id: string; parent_id: string | null }[]
  if (tree.length === 0) {
    hot.close()
    return
  }

  const remaining = new Set(tree.map((r) => r.id))
  const parentOf = new Map(tree.map((r) => [r.id, r.parent_id]))

  const del = hot.prepare(`DELETE FROM session WHERE id = ?`)
  const tx = hot.transaction(() => {
    while (remaining.size > 0) {
      const batch = [...remaining].filter((id) => {
        for (const cid of remaining) {
          if (parentOf.get(cid) === id) return false
        }
        return true
      })
      if (batch.length === 0) break
      for (const id of batch) {
        del.run(id)
        remaining.delete(id)
      }
    }
  })
  tx()
  if (vacuum) hot.run("VACUUM")
  hot.close()
}

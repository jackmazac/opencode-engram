import { createHash } from "node:crypto"
import { createReadStream, createWriteStream, existsSync, promises as fsp, unlinkSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import { pipeline } from "node:stream/promises"
import { createGunzip, createGzip } from "node:zlib"
import { Database } from "bun:sqlite"
import { ulid } from "ulid"
import type { EngramConfig } from "./config.ts"
import { expandArchivePath } from "./config.ts"
import { applyConnPragmas } from "./db.ts"
import { contentHash } from "./hash.ts"

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

async function sha256File(file: string): Promise<{ hash: string; size: number }> {
  const h = createHash("sha256")
  let size = 0
  for await (const chunk of createReadStream(file)) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += b.byteLength
    h.update(b)
  }
  return { hash: h.digest("hex"), size }
}

function treeSessionIdsFromDb(db: Database, projectId: string, rootId: string): string[] {
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
  return rows.map((r) => r.id)
}

/** All session ids in subtree of root (includes root). Opens short-lived RO connection. */
export function treeSessionIds(hotPath: string, projectId: string, rootId: string): string[] {
  const db = new Database(hotPath, { readonly: true })
  applyConnPragmas(db)
  try {
    return treeSessionIdsFromDb(db, projectId, rootId)
  } finally {
    db.close()
  }
}

export function listRootSessionIds(hotPath: string, projectId: string): string[] {
  const db = new Database(hotPath, { readonly: true })
  applyConnPragmas(db)
  try {
    const rows = db.query(`SELECT id FROM session WHERE project_id = ? AND parent_id IS NULL`).all(projectId) as {
      id: string
    }[]
    return rows.map((r) => r.id)
  } finally {
    db.close()
  }
}

export function staleRootIds(hotPath: string, projectId: string, staleDays: number, now: number): string[] {
  const cutoff = now - staleDays * 86400000
  const db = new Database(hotPath, { readonly: true })
  applyConnPragmas(db)
  try {
    const rows = db
      .query(
        `WITH RECURSIVE t(root_id, id, time_updated) AS (
           SELECT id, id, time_updated FROM session WHERE project_id = ? AND parent_id IS NULL
           UNION ALL
           SELECT t.root_id, s.id, s.time_updated FROM session s INNER JOIN t ON s.parent_id = t.id
         )
         SELECT root_id AS id FROM t GROUP BY root_id HAVING max(time_updated) < ?`,
      )
      .all(projectId, cutoff) as { id: string }[]
    return rows.map((r) => r.id)
  } finally {
    db.close()
  }
}

type Ck = {
  exported_message_id: string | null
  exported_part_id: string | null
  exported_count: number
  total_count: number | null
  phase: string
}

export type ArchiveRecord =
  | {
      kind: "session"
      id: string
      project_id: string
      parent_id: string | null
      time_created: number
      time_updated: number
    }
  | {
      kind: "message"
      id: string
      session_id: string
      time_created: number
      data: unknown
    }
  | {
      kind: "part"
      id: string
      message_id: string
      session_id: string
      time_created: number
      data: unknown
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
        ON CONFLICT(project_id, root_session_id) DO UPDATE SET
          exported_message_id = excluded.exported_message_id,
          exported_part_id = excluded.exported_part_id,
          exported_count = excluded.exported_count,
         total_count = excluded.total_count,
         phase = excluded.phase,
         updated_at = excluded.updated_at`,
    )
    .run(root, pid, msgCursor, partCursor, count, total, phase, Date.now())
}

function deleteCheckpoint(memoryDb: Database, projectId: string, rootSessionId: string) {
  memoryDb
    .prepare(`DELETE FROM export_checkpoint WHERE project_id = ? AND root_session_id = ?`)
    .run(projectId, rootSessionId)
}

export async function exportRootSession(opts: ExportOpts): Promise<{ skipped: boolean; path?: string }> {
  const { memoryDb, hotPath, projectId, rootSessionId, cfg, home, force } = opts
  const archiveRoot = expandArchivePath(home, cfg.archive)
  const rel = path.join(projectId, `${rootSessionId}.jsonl.gz`)
  const outAbs = path.join(archiveRoot, rel)
  const tmpAbs = path.join(archiveRoot, projectId, `${rootSessionId}.jsonl.tmp`)

  await fsp.mkdir(path.dirname(outAbs), { recursive: true })

  const existing = memoryDb
    .query(
      `SELECT content_hash, archive_path, session_count, message_count, part_count, time_created
       FROM archive WHERE root_session_id = ? AND project_id = ?`,
    )
    .get(rootSessionId, projectId) as
    | {
        content_hash: string
        archive_path: string
        session_count: number
        message_count: number
        part_count: number
        time_created: number
      }
    | undefined

  const existingAbs = existing ? path.join(archiveRoot, existing.archive_path) : ""
  let sessionCount = 0
  let msgCount = 0
  let partCount = 0

  const ro = new Database(hotPath, { readonly: true })
  applyConnPragmas(ro)
  let roClosed = false
  const closeRo = () => {
    if (roClosed) return
    ro.close()
    roClosed = true
  }

  try {
    const tree = treeSessionIdsFromDb(ro, projectId, rootSessionId)
    if (tree.length === 0) {
      closeRo()
      notify(opts, `No session tree for ${rootSessionId}`)
      return { skipped: true }
    }

    const placeholders = tree.map(() => "?").join(",")
    const treeArgs = tree

    sessionCount = tree.length

    msgCount =
      (
        ro.prepare(`SELECT count(*) AS c FROM message WHERE session_id IN (${placeholders})`).get(...treeArgs) as {
          c: number
        }
      ).c ?? 0
    partCount =
      (
        ro.prepare(`SELECT count(*) AS c FROM part WHERE session_id IN (${placeholders})`).get(...treeArgs) as {
          c: number
        }
      ).c ?? 0
    const treeMaxUpdated =
      (
        ro.prepare(`SELECT max(time_updated) AS m FROM session WHERE id IN (${placeholders})`).get(...treeArgs) as {
          m: number | null
        }
      ).m ?? 0
    if (
      !force &&
      existing &&
      existsSync(existingAbs) &&
      existing.session_count === sessionCount &&
      existing.message_count === msgCount &&
      existing.part_count === partCount &&
      treeMaxUpdated <= existing.time_created
    ) {
      const { hash } = await sha256File(existingAbs)
      if (hash === existing.content_hash) {
        notify(opts, `Skip ${rootSessionId}: archive up to date`)
        closeRo()
        return { skipped: true, path: existing.archive_path }
      }
    }

    if (force) {
      deleteCheckpoint(memoryDb, projectId, rootSessionId)
      if (existsSync(tmpAbs)) unlinkSync(tmpAbs)
    }

    let ckRow = force
      ? undefined
      : (memoryDb
          .query(`SELECT * FROM export_checkpoint WHERE project_id = ? AND root_session_id = ?`)
          .get(projectId, rootSessionId) as Ck | undefined)

    if (!force && ckRow && !existsSync(tmpAbs)) {
      deleteCheckpoint(memoryDb, projectId, rootSessionId)
      ckRow = undefined
    }
    if (!force && !ckRow && existsSync(tmpAbs)) unlinkSync(tmpAbs)

    const deadline = Date.now() + cfg.archive.exportTimeoutMs
    const batch = cfg.archive.batchSize

    const writeLines = async (lines: string[]) => {
      if (lines.length) await fsp.appendFile(tmpAbs, lines.join(""), "utf8")
    }

    const skipMessages = !force && ckRow?.phase === "parts"
    let lastMsgId = ""
    let exportedMsgs = 0
    if (!force && ckRow?.phase === "messages") {
      lastMsgId = ckRow.exported_message_id ?? ""
      exportedMsgs = ckRow.exported_count
    }

    if (!skipMessages) {
      if (!ckRow) {
        const sessionRows = ro
          .prepare(
            `SELECT id, project_id, parent_id, time_created, time_updated FROM session
             WHERE id IN (${placeholders}) ORDER BY time_created, id`,
          )
          .all(...treeArgs) as {
          id: string
          project_id: string
          parent_id: string | null
          time_created: number
          time_updated: number
        }[]
        await writeLines(sessionRows.map((r) => `${JSON.stringify({ kind: "session", ...r })}\n`))
      }

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
          closeRo()
          return { skipped: false, path: rel }
        }

        const rows = ro
          .prepare(
            `SELECT id, session_id, time_created, data FROM message
         WHERE session_id IN (${placeholders}) AND id > ?
         ORDER BY id LIMIT ?`,
          )
          .all(...treeArgs, lastMsgId, batch) as {
          id: string
          session_id: string
          time_created: number
          data: string
        }[]
        if (rows.length === 0) break

        const lines: string[] = []
        for (const r of rows) {
          const rec = {
            kind: "message" as const,
            id: r.id,
            session_id: r.session_id,
            time_created: r.time_created,
            data: JSON.parse(r.data) as unknown,
          }
          lines.push(`${JSON.stringify(rec)}\n`)
          lastMsgId = r.id
          exportedMsgs++
        }
        await writeLines(lines)

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
        closeRo()
        return { skipped: false, path: rel }
      }

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
      if (rows.length === 0) break

      const lines: string[] = []
      for (const r of rows) {
        const rec = {
          kind: "part" as const,
          id: r.id,
          message_id: r.message_id,
          session_id: r.session_id,
          time_created: r.time_created,
          data: JSON.parse(r.data) as unknown,
        }
        lines.push(`${JSON.stringify(rec)}\n`)
        lastPartId = r.id
        exportedParts++
      }
      await writeLines(lines)

      notify(opts, `Exporting ${rootSessionId}: ${exportedParts}/${partCount} parts`)
      await new Promise((r) => setImmediate(r))
    }

    if (!existsSync(tmpAbs)) {
      notify(opts, `Nothing to export for ${rootSessionId}`)
      deleteCheckpoint(memoryDb, projectId, rootSessionId)
      closeRo()
      return { skipped: true }
    }
  } finally {
    closeRo()
  }

  await pipeline(createReadStream(tmpAbs), createGzip(), createWriteStream(outAbs))
  unlinkSync(tmpAbs)

  const { hash, size } = await sha256File(outAbs)
  const relOut = path.join(projectId, `${rootSessionId}.jsonl.gz`)

  if (existing && !force && existing.content_hash === hash) {
    deleteCheckpoint(memoryDb, projectId, rootSessionId)
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
    .run(archiveId, rootSessionId, projectId, sessionCount, msgCount, partCount, relOut, size, hash, Date.now())

  deleteCheckpoint(memoryDb, projectId, rootSessionId)

  notify(opts, `Wrote ${relOut} (${size} bytes)`)
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

export async function verifyArchiveFile(opts: {
  memoryDb: Database
  archiveRoot: string
  projectId: string
  rootSessionId: string
}): Promise<{ ok: boolean; detail: string }> {
  const row = opts.memoryDb
    .query(`SELECT content_hash, archive_path FROM archive WHERE root_session_id = ? AND project_id = ?`)
    .get(opts.rootSessionId, opts.projectId) as { content_hash: string; archive_path: string } | undefined
  if (!row) return { ok: false, detail: "No archive row" }
  const abs = path.join(opts.archiveRoot, row.archive_path)
  if (!existsSync(abs)) return { ok: false, detail: `Missing file ${abs}` }
  const { hash: h } = await sha256File(abs)
  if (h !== row.content_hash)
    return {
      ok: false,
      detail: `Hash mismatch file=${h} row=${row.content_hash}`,
    }
  return { ok: true, detail: "OK" }
}

export async function* readArchiveRecords(file: string): AsyncGenerator<ArchiveRecord> {
  const rl = createInterface({
    input: createReadStream(file).pipe(createGunzip()),
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const record = JSON.parse(trimmed) as ArchiveRecord
    if (record.kind === "session" || record.kind === "message" || record.kind === "part") yield record
  }
}

function archiveAbs(memoryDb: Database, archiveRoot: string, projectId: string, rootSessionId: string): string {
  const row = memoryDb
    .query(`SELECT archive_path FROM archive WHERE root_session_id = ? AND project_id = ?`)
    .get(rootSessionId, projectId) as { archive_path: string } | undefined
  if (!row) throw new Error(`No archive row for ${rootSessionId}`)
  return path.join(archiveRoot, row.archive_path)
}

export async function inspectArchive(opts: {
  memoryDb: Database
  archiveRoot: string
  projectId: string
  rootSessionId: string
}): Promise<{ sessions: number; messages: number; parts: number }> {
  const counts = { sessions: 0, messages: 0, parts: 0 }
  for await (const record of readArchiveRecords(
    archiveAbs(opts.memoryDb, opts.archiveRoot, opts.projectId, opts.rootSessionId),
  )) {
    if (record.kind === "session") counts.sessions++
    if (record.kind === "message") counts.messages++
    if (record.kind === "part") counts.parts++
  }
  return counts
}

export async function restoreArchiveToHot(opts: {
  memoryDb: Database
  archiveRoot: string
  hotPath: string
  projectId: string
  rootSessionId: string
  dryRun: boolean
}): Promise<{ sessions: number; messages: number; parts: number; applied: boolean }> {
  const file = archiveAbs(opts.memoryDb, opts.archiveRoot, opts.projectId, opts.rootSessionId)
  const records: ArchiveRecord[] = []
  for await (const record of readArchiveRecords(file)) records.push(record)
  const counts = {
    sessions: records.filter((r) => r.kind === "session").length,
    messages: records.filter((r) => r.kind === "message").length,
    parts: records.filter((r) => r.kind === "part").length,
    applied: false,
  }
  if (opts.dryRun) return counts

  const hot = new Database(opts.hotPath)
  applyConnPragmas(hot)
  try {
    const insSession = hot.prepare(
      `INSERT OR IGNORE INTO session (id, project_id, parent_id, time_created, time_updated) VALUES (?,?,?,?,?)`,
    )
    const insMessage = hot.prepare(
      `INSERT OR IGNORE INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)`,
    )
    const insPart = hot.prepare(
      `INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)`,
    )
    const tx = hot.transaction(() => {
      for (const record of records) {
        if (record.kind === "session") {
          insSession.run(record.id, record.project_id, record.parent_id, record.time_created, record.time_updated)
        } else if (record.kind === "message") {
          insMessage.run(record.id, record.session_id, record.time_created, JSON.stringify(record.data))
        } else {
          insPart.run(record.id, record.message_id, record.session_id, record.time_created, JSON.stringify(record.data))
        }
      }
    })
    tx()
    counts.applied = true
    return counts
  } finally {
    hot.close()
  }
}

export async function searchArchive(opts: {
  memoryDb: Database
  archiveRoot: string
  projectId: string
  rootSessionId: string
  query: string
  limit: number
}): Promise<string[]> {
  const needle = opts.query.toLowerCase()
  const out: string[] = []
  for await (const record of readArchiveRecords(
    archiveAbs(opts.memoryDb, opts.archiveRoot, opts.projectId, opts.rootSessionId),
  )) {
    const hay = JSON.stringify(record).toLowerCase()
    if (!hay.includes(needle)) continue
    out.push(`${record.kind}:${"id" in record ? record.id : "unknown"}\t${hay.slice(0, 500)}`)
    if (out.length >= opts.limit) break
  }
  return out
}

export async function importArchiveToMemory(opts: {
  memoryDb: Database
  archiveRoot: string
  projectId: string
  rootSessionId: string
  cfg: EngramConfig
}): Promise<{ inserted: number; scannedParts: number }> {
  const file = archiveAbs(opts.memoryDb, opts.archiveRoot, opts.projectId, opts.rootSessionId)
  const messages = new Map<string, { role?: string; agent?: string; modelID?: string }>()
  const parts: Extract<ArchiveRecord, { kind: "part" }>[] = []
  for await (const record of readArchiveRecords(file)) {
    if (record.kind === "message" && record.data && typeof record.data === "object") {
      messages.set(record.id, record.data as { role?: string; agent?: string; modelID?: string })
    }
    if (record.kind === "part") parts.push(record)
  }

  const exists = opts.memoryDb.prepare(
    `SELECT 1 FROM chunk WHERE project_id = ? AND session_id = ? AND message_id = ? AND coalesce(part_id, '') = ? AND content_hash = ? LIMIT 1`,
  )
  const ins = opts.memoryDb.prepare(
    `INSERT INTO chunk (
      id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
      file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
      time_created, content_hash, root_session_id, session_depth, plan_slug
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
  let inserted = 0
  const tx = opts.memoryDb.transaction(() => {
    for (const part of parts) {
      const msg = messages.get(part.message_id)
      if (msg?.role !== "assistant") continue
      if (!part.data || typeof part.data !== "object") continue
      const data = part.data as { type?: string; text?: string }
      if (data.type !== "text" || !data.text?.trim()) continue
      const content = data.text.slice(0, opts.cfg.sidecar.maxChunkLength)
      const hash = contentHash(content)
      if (exists.get(opts.projectId, part.session_id, part.message_id, part.id, hash)) continue
      ins.run(
        ulid(),
        part.session_id,
        part.message_id,
        part.id,
        opts.projectId,
        "assistant",
        msg.agent ?? null,
        msg.modelID ?? null,
        "discovery",
        content,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        part.time_created,
        hash,
        opts.rootSessionId,
        0,
        null,
      )
      inserted++
    }
  })
  tx()
  return { inserted, scannedParts: parts.length }
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
    .all(rootSessionId, projectId) as {
    id: string
    parent_id: string | null
  }[]
  if (tree.length === 0) {
    hot.close()
    return
  }

  const childCount = new Map<string, number>()
  const parentOf = new Map<string, string | null>()
  for (const r of tree) {
    parentOf.set(r.id, r.parent_id)
    if (r.parent_id) childCount.set(r.parent_id, (childCount.get(r.parent_id) ?? 0) + 1)
    if (!childCount.has(r.id)) childCount.set(r.id, childCount.get(r.id) ?? 0)
  }
  const leaves = tree.filter((r) => (childCount.get(r.id) ?? 0) === 0).map((r) => r.id)

  const del = hot.prepare(`DELETE FROM session WHERE id = ?`)
  const tx = hot.transaction(() => {
    for (let i = 0; i < leaves.length; i++) {
      const id = leaves[i]
      if (!id) continue
      del.run(id)
      const parent = parentOf.get(id)
      if (!parent) continue
      const next = (childCount.get(parent) ?? 0) - 1
      childCount.set(parent, next)
      if (next === 0) leaves.push(parent)
    }
  })
  tx()
  if (vacuum) hot.run("VACUUM")
  hot.close()
}

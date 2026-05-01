import type { PluginInput } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import { ulid } from "ulid"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { EngramConfig } from "./config.ts"
import { loadConfig } from "./config.ts"
import { exportRootSession, staleRootIds } from "./archive.ts"
import { backfillDone, backfillFromHot, markBackfillProgress } from "./backfill.ts"
import { applyConnPragmas, openMemoryDb, sidecarPath } from "./db.ts"
import * as capture from "./capture.ts"
import { defaultHotDbPath } from "./paths.ts"
import type { ChunkInsert } from "./types.ts"
import { embedTexts, resolveApiKey } from "./openai.ts"
import { classifyBatch } from "./classify.ts"
import { buildContextBundle, formatContextBundle } from "./context.ts"
import { formatHits, searchMemory } from "./retrieve.ts"
import { ORCHESTRATOR_HINT_BLOCK, appendOrchestratorHint, systemLooksInternal } from "./orchestrator-hint.ts"
import {
  formatTelemetryReport,
  memorySnapshot,
  pruneMetrics,
  recentMetrics,
  recordMetric as insertMetric,
} from "./telemetry.ts"

export class EngramRuntime {
  db: Database
  cfg: EngramConfig
  input: PluginInput
  key: string | undefined

  private pEmbQueue!: ReturnType<Database["prepare"]>
  private pStatsOverview!: ReturnType<Database["prepare"]>
  private pStatsByType!: ReturnType<Database["prepare"]>
  private pStatsArch!: ReturnType<Database["prepare"]>
  private pStatsCk!: ReturnType<Database["prepare"]>
  private pMetaBackfill!: ReturnType<Database["prepare"]>
  private pFrictionLatest!: ReturnType<Database["prepare"]>
  private pLogRef!: ReturnType<Database["prepare"]>
  private pForgetSessCt!: ReturnType<Database["prepare"]>
  private pInsRetrieval!: ReturnType<Database["prepare"]>
  private pUpsertSessMem!: ReturnType<Database["prepare"]>
  private pInsertChunk!: ReturnType<Database["prepare"]>
  private pCopyEmbedding!: ReturnType<Database["prepare"]>
  private pUpdateEmbedding!: ReturnType<Database["prepare"]>
  private pUpdateRetrievalRefs!: ReturnType<Database["prepare"]>

  private writeBuf: ChunkInsert[] = []
  private timers: ReturnType<typeof setInterval>[] = []
  private sessionAgent = new Map<string, { agent: string | null; model: string | null }>()
  private planSlug = new Map<string, string | null>()
  private lastRetrieval = new Map<string, { ids: string[]; logId: string }>()
  private archiveBusy = false
  private embedBusy = false

  constructor(input: PluginInput, cfg: EngramConfig) {
    this.input = input
    this.cfg = cfg
    const sp = sidecarPath(input.worktree, cfg)
    fs.mkdirSync(path.dirname(sp), { recursive: true })
    this.db = openMemoryDb(sp)
    this.key = resolveApiKey(cfg.openaiApiKey)
    const d = this.db
    this.pEmbQueue = d.prepare(
      `SELECT id, content, content_hash, content_type, agent FROM chunk
       WHERE time_embedded IS NULL AND project_id = ?
       ORDER BY time_created ASC LIMIT ?`,
    )
    this.pStatsOverview = d.prepare(
      `SELECT
         count(*) AS total,
         sum(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS emb
       FROM chunk WHERE project_id = ?`,
    )
    this.pStatsByType = d.prepare(
      `SELECT content_type, count(*) AS n FROM chunk WHERE project_id = ? GROUP BY content_type`,
    )
    this.pStatsArch = d.prepare(`SELECT count(*) AS c FROM archive WHERE project_id = ?`)
    this.pStatsCk = d.prepare(`SELECT count(*) AS c FROM export_checkpoint WHERE project_id = ?`)
    this.pMetaBackfill = d.prepare(`SELECT v FROM engram_meta WHERE k = 'backfill_v1_done'`)
    this.pFrictionLatest = d.prepare(`SELECT report FROM friction_cache ORDER BY time_created DESC LIMIT 1`)
    this.pLogRef = d.prepare(`SELECT referenced_ids FROM retrieval_log WHERE id = ?`)
    this.pForgetSessCt = d.prepare(`SELECT count(*) AS c FROM chunk WHERE session_id = ? AND project_id = ?`)
    this.pInsRetrieval = d.prepare(
      `INSERT INTO retrieval_log (id, session_id, query, returned_ids, time_created)
       VALUES (?, ?, ?, ?, ?)`,
    )
    this.pUpsertSessMem = d.prepare(
      `INSERT INTO session_memory_last (session_id, log_id, chunk_ids, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET log_id = excluded.log_id, chunk_ids = excluded.chunk_ids, updated_at = excluded.updated_at`,
    )
    this.pInsertChunk = d.prepare(
      `INSERT INTO chunk (
        id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
        file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
        time_created, content_hash, root_session_id, session_depth, plan_slug
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    this.pCopyEmbedding = d.prepare(
      `SELECT embedding FROM chunk
       WHERE project_id = ? AND content_hash = ? AND embedding_model = ? AND embedding_dimensions = ? AND embedding IS NOT NULL
       LIMIT 1`,
    )
    this.pUpdateEmbedding = d.prepare(
      `UPDATE chunk SET embedding = ?, time_embedded = ?, embedding_model = ?, embedding_dimensions = ? WHERE id = ?`,
    )
    this.pUpdateRetrievalRefs = d.prepare(`UPDATE retrieval_log SET referenced_ids = ? WHERE id = ?`)

    const wMs = 500
    this.timers.push(
      setInterval(() => {
        this.drainWrite()
      }, wMs),
    )
    this.timers.push(
      setInterval(() => {
        void this.drainEmbed()
      }, cfg.embed.intervalMs),
    )
    this.timers.push(
      setInterval(() => {
        this.drainBackfill()
      }, 60_000),
    )
    queueMicrotask(() => this.drainBackfill())
  }

  close() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.db.close()
  }

  onMessageUpdated(ev: { properties?: { info?: Record<string, unknown> } }) {
    const info = ev.properties?.info
    if (!info) return
    const role = info.role as string
    if (role !== "assistant") return
    const sid = info.sessionID as string
    this.sessionAgent.set(sid, {
      agent: info.agent as string,
      model: info.modelID as string,
    })
    const rows = capture.fromAssistantError(info, this.input.project.id, this.cfg, this.planSlug.get(sid) ?? null)
    this.enqueue(rows)
  }

  onPartUpdated(ev: { properties?: { part?: Record<string, unknown> } }) {
    const part = ev.properties?.part
    if (!part) return
    const sid = part.sessionID as string
    const ctx = this.sessionAgent.get(sid) ?? { agent: null, model: null }
    const rows = capture.fromPart(part, this.input.project.id, this.cfg, this.planSlug.get(sid) ?? null, ctx)
    this.enqueue(rows)
  }

  onToolAfter(tool: string, sessionID: string, output: string) {
    const rows = capture.fromMirroredTool(
      tool,
      output,
      sessionID,
      this.input.project.id,
      this.cfg,
      this.planSlug.get(sessionID) ?? null,
    )
    this.enqueue(rows)
    if (tool === "plan" || tool === "journal") {
      const slug = extractSlug(output)
      if (slug) this.planSlug.set(sessionID, slug)
    }

    const last = this.lastRetrieval.get(sessionID)
    if (last?.ids.length) {
      const feedbackOutput = output.length > 20_000 ? `${output.slice(0, 10_000)}\n${output.slice(-10_000)}` : output
      queueMicrotask(() => this.feedbackHook(sessionID, tool, feedbackOutput))
    }
  }

  drainBackfill() {
    if (!this.cfg.enabled || !this.cfg.backfill.enabled) return
    if (backfillDone(this.db)) return
    const hp = this.cfg.archive.hotDbPath ?? defaultHotDbPath()
    if (!fs.existsSync(hp)) return
    const start = performance.now()
    const before = memorySnapshot()
    let status: "ok" | "error" = "ok"
    let rowsCount = 0
    let detail: Record<string, unknown> = { hotDb: hp }
    this.drainWrite()
    const hot = new Database(hp, { readonly: true })
    applyConnPragmas(hot)
    let result: ReturnType<typeof backfillFromHot> | undefined
    try {
      result = backfillFromHot({
        hot,
        memory: this.db,
        projectId: this.input.project.id,
        cfg: this.cfg,
        batchLimit: 300,
      })
    } catch (e) {
      status = "error"
      detail = { ...detail, error: e instanceof Error ? e.message : String(e) }
    } finally {
      hot.close()
    }
    if (!result) {
      this.recordMetric("backfill.drain", status, performance.now() - start, rowsCount, null, before, detail)
      return
    }
    if (result.rows.length) rowsCount = this.insertRows(result.rows)
    markBackfillProgress(this.db, result)
    detail = {
      ...detail,
      capturedRows: result.rows.length,
      insertedRows: rowsCount,
      done: result.done,
    }
    this.recordMetric("backfill.drain", status, performance.now() - start, rowsCount, null, before, detail)
  }

  private enqueue(rows: ChunkInsert[]) {
    if (!this.cfg.enabled) return
    for (const r of rows) {
      if (this.writeBuf.length >= this.cfg.embed.queueMax) this.drainWrite()
      if (this.writeBuf.length >= this.cfg.embed.queueMax) this.writeBuf.shift()
      const id = ulid()
      r.id = id
      this.writeBuf.push(r)
    }
  }

  private drainWrite() {
    if (this.writeBuf.length === 0) return
    const batch = this.writeBuf.splice(0, 50)
    this.insertRows(batch)
  }

  private insertRows(batch: ChunkInsert[]) {
    if (batch.length === 0) return 0
    const seen = this.existingChunkKeys(batch)
    let inserted = 0
    const tx = this.db.transaction((rows: ChunkInsert[]) => {
      for (const r of rows) {
        if (!r.id) r.id = ulid()
        const key = chunkIdentityKey(r)
        if (seen.has(key)) continue
        this.pInsertChunk.run(
          r.id,
          r.session_id,
          r.message_id,
          r.part_id,
          r.project_id,
          r.role,
          r.agent,
          r.model,
          r.content_type,
          r.content,
          r.file_paths,
          r.tool_name,
          r.tool_status,
          r.output_head,
          r.output_tail,
          r.output_length,
          r.error_class,
          r.time_created,
          r.content_hash,
          r.root_session_id,
          r.session_depth,
          r.plan_slug,
        )
        seen.add(key)
        inserted++
      }
    })
    tx(batch)
    return inserted
  }

  private existingChunkKeys(batch: ChunkInsert[]): Set<string> {
    const wanted = new Map<string, ChunkInsert>()
    for (const row of batch) wanted.set(chunkIdentityKey(row), row)
    if (wanted.size === 0) return new Set()

    const clauses = Array.from(wanted.values())
      .map(() => `(session_id = ? AND message_id = ? AND coalesce(part_id, '') = ? AND content_hash = ?)`)
      .join(" OR ")
    const args: string[] = [this.input.project.id]
    for (const r of wanted.values()) args.push(r.session_id, r.message_id, r.part_id ?? "", r.content_hash)

    const rows = this.db
      .query(
        `SELECT session_id, message_id, coalesce(part_id, '') AS part_key, content_hash
         FROM chunk
         WHERE project_id = ? AND (${clauses})`,
      )
      .all(...args) as {
      session_id: string
      message_id: string
      part_key: string
      content_hash: string
    }[]

    return new Set(
      rows.map((r) => `${this.input.project.id}\0${r.session_id}\0${r.message_id}\0${r.part_key}\0${r.content_hash}`),
    )
  }

  private recordMetric(
    operation: string,
    status: "ok" | "error" | "skip",
    durationMs: number,
    rowsCount: number | null,
    bytesCount: number | null,
    before: ReturnType<typeof memorySnapshot>,
    detail: Record<string, unknown> | null,
  ) {
    if (!this.cfg.telemetry.enabled) return
    try {
      insertMetric(this.db, {
        projectId: this.input.project.id,
        operation,
        status,
        durationMs,
        rowsCount,
        bytesCount,
        before,
        after: memorySnapshot(),
        detail,
        detailMaxLength: this.cfg.telemetry.detailMaxLength,
      })
    } catch {
      /* telemetry must never break plugin hooks */
    }
  }

  private async drainEmbed() {
    if (this.embedBusy) return
    const key = this.key
    if (!key) return
    this.embedBusy = true
    const start = performance.now()
    const before = memorySnapshot()
    let status: "ok" | "error" | "skip" = "ok"
    let rowsCount = 0
    let cacheHits = 0
    let detail: Record<string, unknown> | null = null
    try {
      const cfg = this.cfg
      const rows = this.pEmbQueue.all(this.input.project.id, cfg.embed.batchSize) as {
        id: string
        content: string
        content_hash: string
        content_type: string
        agent: string | null
      }[]

      if (rows.length === 0) return
      rowsCount = rows.length

      const need: typeof rows = []
      const now = Date.now()
      for (const r of rows) {
        if (cfg.embed.cacheByHash) {
          const ex = this.pCopyEmbedding.get(
            this.input.project.id,
            r.content_hash,
            cfg.embed.model,
            cfg.sidecar.dimensions,
          ) as { embedding: Buffer } | undefined
          if (ex?.embedding && ex.embedding.byteLength === cfg.sidecar.dimensions * 4) {
            this.pUpdateEmbedding.run(ex.embedding, now, cfg.embed.model, cfg.sidecar.dimensions, r.id)
            cacheHits++
            continue
          }
        }
        need.push(r)
      }

      if (need.length === 0) {
        status = "skip"
        detail = { selectedRows: rows.length, cacheHits, embeddedRows: 0 }
        return
      }

      let vecs: number[][] = []
      try {
        vecs = await embedTexts({
          key,
          model: cfg.embed.model,
          dimensions: cfg.sidecar.dimensions,
          inputs: need.map((r) => r.content.slice(0, 8000)),
        })
      } catch (e) {
        status = "error"
        detail = {
          selectedRows: rows.length,
          cacheHits,
          embeddedRows: 0,
          error: e instanceof Error ? e.message : String(e),
        }
        return
      }

      for (let i = 0; i < need.length; i++) {
        const r = need[i]
        const v = vecs[i]
        if (!r || !v) continue
        const f32 = new Float32Array(v)
        const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
        this.pUpdateEmbedding.run(buf, now, cfg.embed.model, cfg.sidecar.dimensions, r.id)
      }

      const classified = need.map((r) => ({
        id: r.id,
        content: r.content,
        agent: r.agent,
      }))
      try {
        await classifyBatch({ db: this.db, cfg, key, rows: classified })
      } catch {
        /* keep provisional */
      }
      detail = {
        selectedRows: rows.length,
        cacheHits,
        embeddedRows: need.length,
        classifiedRows: classified.length,
      }
    } finally {
      if (rowsCount > 0) {
        this.recordMetric("embed.drain", status, performance.now() - start, rowsCount, null, before, detail)
      }
      this.embedBusy = false
    }
  }

  async memoryTool(query: string, scope: string | undefined, limit: number | undefined, sessionID: string) {
    const key = this.key
    if (!key) throw new Error("OPENAI_API_KEY or engram.openaiApiKey required for memory search")
    const lim = limit ?? 5
    const start = performance.now()
    const before = memorySnapshot()
    let status: "ok" | "error" = "ok"
    let hitCount = 0
    let detail: Record<string, unknown> = {
      queryLength: query.length,
      scope: scope ?? "broad",
      limit: lim,
    }
    try {
      const { hits, metrics } = await searchMemory({
        db: this.db,
        cfg: this.cfg,
        projectId: this.input.project.id,
        query,
        scope,
        limit: lim,
        key,
        skipRerank: false,
      })
      hitCount = hits.length
      detail = { ...detail, ...metrics }

      const logId = ulid()
      this.pInsRetrieval.run(logId, sessionID, query, JSON.stringify(hits.map((h) => h.id)), Date.now())
      this.lastRetrieval.set(sessionID, { ids: hits.map((h) => h.id), logId })

      this.pUpsertSessMem.run(sessionID, logId, JSON.stringify(hits.map((h) => h.id)), Date.now())

      return formatHits(hits)
    } catch (e) {
      status = "error"
      detail = { ...detail, error: e instanceof Error ? e.message : String(e) }
      throw e
    } finally {
      this.recordMetric("memory.search", status, performance.now() - start, hitCount, null, before, detail)
    }
  }

  async injectSystem(sessionID: string | undefined, system: string[]): Promise<void> {
    if (!sessionID) return
    if (systemLooksInternal(system.join("\n"))) return
    await this.applyOrchestratorHint(sessionID, system)

    if (!this.cfg.proactive.enabled) return
    const key = this.key
    if (!key) return
    let seed = ""
    try {
      const res = await this.input.client.session.messages({
        path: { id: sessionID },
        query: { directory: this.input.directory, limit: 30 },
      })
      const raw = res as {
        data?: Array<{
          info: { role: string }
          parts: Array<{ type?: string; text?: string }>
        }>
      }
      const msgs = raw.data ?? []
      const first = msgs.find((m) => m.info.role === "user") ?? msgs[0]
      if (first) {
        const parts = first.parts ?? []
        const text = parts.find((p) => p.type === "text")
        seed = text?.text ?? ""
      }
    } catch {
      return
    }
    if (!seed.trim()) return

    const { hits } = await searchMemory({
      db: this.db,
      cfg: this.cfg,
      projectId: this.input.project.id,
      query: seed.slice(0, 2000),
      scope: undefined,
      limit: this.cfg.proactive.maxChunks,
      key,
      skipRerank: this.cfg.proactive.skipRerank,
    })

    if (hits.length === 0) return
    const budget = this.cfg.proactive.maxTokens * 4
    const bullets: string[] = []
    let n = 0
    for (const h of hits) {
      const line = `• ${h.content.replace(/\s+/g, " ").slice(0, 400)} [session:${h.session_id.slice(0, 8)}]`
      if (n + line.length + 1 > budget) break
      bullets.push(line)
      n += line.length + 1
    }
    if (!bullets.length) return
    const block = `<!-- Engram -->\n<project_memory>\nRelevant context from past sessions:\n\n${bullets.join("\n")}\n</project_memory>`
    system.push(block)
  }

  private async applyOrchestratorHint(sessionID: string, system: string[]) {
    if (!this.cfg.hints.orchestrator) return
    try {
      const res = await this.input.client.session.get({
        path: { id: sessionID },
        query: { directory: this.input.directory },
      })
      const raw = res as { data?: { parentID?: string } }
      if (raw.data?.parentID) return
    } catch {
      return
    }
    appendOrchestratorHint(system, ORCHESTRATOR_HINT_BLOCK)
  }

  forgetTool(opts: { chunk_ids?: string[]; session_id?: string; pattern?: string; dry_run?: boolean }) {
    const dry = opts.dry_run !== false
    const cap = this.cfg.memorySearch.forgetPatternMaxRows

    if (opts.chunk_ids?.length) {
      const placeholders = opts.chunk_ids.map(() => "?").join(",")
      const n = this.db
        .query(`SELECT count(*) AS c FROM chunk WHERE id IN (${placeholders}) AND project_id = ?`)
        .get(...opts.chunk_ids, this.input.project.id) as { c: number }
      if (dry) return `Would delete ${n.c} chunks (dry_run).`
      const del = this.db.prepare(`DELETE FROM chunk WHERE id = ? AND project_id = ?`)
      const tx = this.db.transaction((ids: string[]) => {
        for (const id of ids) del.run(id, this.input.project.id)
      })
      tx(opts.chunk_ids)
      return `Deleted ${opts.chunk_ids.length} chunk ids.`
    }

    if (opts.session_id) {
      const n = this.pForgetSessCt.get(opts.session_id, this.input.project.id) as { c: number }
      if (dry) return `Would delete ${n.c} chunks for session (dry_run).`
      this.db
        .prepare(`DELETE FROM chunk WHERE session_id = ? AND project_id = ?`)
        .run(opts.session_id, this.input.project.id)
      return `Deleted chunks for session ${opts.session_id}.`
    }

    if (opts.pattern) {
      const matchPat = `"${opts.pattern.replace(/"/g, '""')}"`
      const rows = this.db
        .query(
          `SELECT c.id FROM chunk_fts INNER JOIN chunk c ON c.id = chunk_fts.chunk_id
           WHERE chunk_fts MATCH ? AND c.project_id = ? LIMIT ?`,
        )
        .all(matchPat, this.input.project.id, cap + 1) as { id: string }[]

      if (rows.length > cap)
        return `Pattern matches ${rows.length}+ rows (cap ${cap}). Refine pattern or pass dry_run false with smaller scope.`

      if (dry) return `Would delete ${rows.length} chunks matching pattern (dry_run).`
      const del = this.db.prepare(`DELETE FROM chunk WHERE id = ? AND project_id = ?`)
      const tx = this.db.transaction((ids: string[]) => {
        for (const id of ids) del.run(id, this.input.project.id)
      })
      tx(rows.map((r) => r.id))
      return `Deleted ${rows.length} chunks.`
    }

    return "Specify chunk_ids, session_id, or pattern."
  }

  feedbackTool(opts: { chunk_id: string; rating: "up" | "down"; note?: string; session_id?: string }) {
    this.db
      .prepare(
        `INSERT INTO retrieval_feedback (id, project_id, chunk_id, session_id, rating, note, time_created)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
        this.input.project.id,
        opts.chunk_id,
        opts.session_id ?? null,
        opts.rating,
        opts.note ?? null,
        Date.now(),
      )
    return `Recorded ${opts.rating} feedback for ${opts.chunk_id}.`
  }

  contextTool(opts: { query: string; limit?: number }) {
    return formatContextBundle(
      buildContextBundle({
        db: this.db,
        projectId: this.input.project.id,
        query: opts.query,
        limit: opts.limit ?? 12,
      }),
    )
  }

  statsTool(report: string | undefined) {
    const pid = this.input.project.id
    const ttl = this.cfg.insights.cacheDays * 86400000
    this.db.prepare(`DELETE FROM friction_cache WHERE time_created < ?`).run(Date.now() - ttl)

    const overview = this.pStatsOverview.get(pid) as {
      total: number
      emb: number
    }

    const byType = this.pStatsByType.all(pid) as {
      content_type: string
      n: number
    }[]

    if (report === "db-health" || report === "overview" || !report) {
      const arch = this.pStatsArch.get(pid) as { c: number }
      const ck = this.pStatsCk.get(pid) as { c: number }
      const bf = this.pMetaBackfill.get() as { v: string } | undefined
      const side = sidecarPath(this.input.worktree, this.cfg)
      let memSz = ""
      let hotSz = ""
      if (fs.existsSync(side)) memSz = ` sidecar=${fs.statSync(side).size}b`
      const hot = this.cfg.archive.hotDbPath ?? defaultHotDbPath()
      if (fs.existsSync(hot)) hotSz = ` hot=${fs.statSync(hot).size}b`
      return `Engram: ${overview.total} chunks | ${overview.emb} embedded
By type: ${byType.map((x) => `${x.content_type} ${x.n}`).join(" | ")}
Archives: ${arch.c} | export checkpoints: ${ck.c} | backfill_done: ${bf?.v ?? "0"}${memSz}${hotSz}`
    }

    if (report === "insights") {
      const row = this.pFrictionLatest.get() as { report: string } | undefined
      return row?.report ?? "No insights cached yet."
    }

    if (report === "telemetry") {
      pruneMetrics(this.db, pid, this.cfg.telemetry.retainDays)
      return formatTelemetryReport(recentMetrics(this.db, pid, 200), "last 200")
    }

    return `Report "${report}" not implemented in v1 — use overview | db-health | insights | telemetry.`
  }

  feedbackHook(sessionID: string, _tool: string, output: string) {
    const last = this.lastRetrieval.get(sessionID)
    if (!last || last.ids.length === 0) return
    const log = this.pLogRef.get(last.logId) as { referenced_ids: string | null } | undefined
    const cited = new Set<string>()
    if (log?.referenced_ids) {
      try {
        const p: unknown = JSON.parse(log.referenced_ids)
        if (Array.isArray(p)) for (const id of p) if (typeof id === "string") cited.add(id)
      } catch {
        /* ignore */
      }
    }
    for (const id of last.ids) {
      if (output.includes(id.slice(0, 12))) cited.add(id)
    }
    this.pUpdateRetrievalRefs.run(JSON.stringify([...cited]), last.logId)
  }

  onSessionIdle(ev: { properties?: { sessionID?: string } }) {
    const sessionID = ev.properties?.sessionID
    void this.maybeArchive(sessionID)
    if (sessionID) this.pruneSessionState(sessionID)
  }

  private pruneSessionState(sessionID: string) {
    this.sessionAgent.delete(sessionID)
    this.planSlug.delete(sessionID)
    this.lastRetrieval.delete(sessionID)
  }

  private async maybeArchive(sessionID: string | undefined) {
    if (!sessionID || !this.cfg.archive.onlyWhenIdle || !this.cfg.archive.autoCaptureBefore) return
    if (this.archiveBusy) return
    const hotPath = this.cfg.archive.hotDbPath ?? defaultHotDbPath()
    if (!fs.existsSync(hotPath)) return

    let busy = false
    try {
      const st = await this.input.client.session.status({
        query: { directory: this.input.directory },
      })
      const data = st.data
      if (data && typeof data === "object") {
        for (const k of Object.keys(data)) {
          const s = data[k]
          if (s && typeof s === "object" && (s.type === "busy" || s.type === "retry")) {
            busy = true
            break
          }
        }
      }
    } catch {
      return
    }
    if (busy) return

    const roots = staleRootIds(hotPath, this.input.project.id, this.cfg.archive.staleDays, Date.now())
    const root = roots[0]
    if (!root) return

    this.archiveBusy = true
    try {
      await exportRootSession({
        memoryDb: this.db,
        hotPath,
        projectId: this.input.project.id,
        rootSessionId: root,
        cfg: this.cfg,
        home: os.homedir(),
        force: false,
      })
    } finally {
      this.archiveBusy = false
    }
  }
}

function chunkIdentityKey(
  r: Pick<ChunkInsert, "project_id" | "session_id" | "message_id" | "part_id" | "content_hash">,
): string {
  return `${r.project_id}\0${r.session_id}\0${r.message_id}\0${r.part_id ?? ""}\0${r.content_hash}`
}

function extractSlug(out: string): string | null {
  const m = out.match(/slug[:\s]+([\w-]+)/i)
  return m?.[1] ?? null
}

const runtimes = new Map<string, EngramRuntime>()

export function getRuntime(input: PluginInput): EngramRuntime {
  const key = `${input.worktree}\0${input.project.id}`
  let r = runtimes.get(key)
  if (!r) {
    const cfg = loadConfig(input.worktree)
    r = new EngramRuntime(input, cfg)
    runtimes.set(key, r)
  }
  return r
}

import type { PluginInput } from "@opencode-ai/plugin"
import { Database } from "bun:sqlite"
import { ulid } from "ulid"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { EngramConfig } from "./config.ts"
import { loadConfig } from "./config.ts"
import { exportRootSession, staleRootIds } from "./archive.ts"
import { backfillFromHot } from "./backfill.ts"
import { applyConnPragmas, openMemoryDb, sidecarPath } from "./db.ts"
import * as capture from "./capture.ts"
import { defaultHotDbPath } from "./paths.ts"
import type { ChunkInsert } from "./types.ts"
import { embedTexts, resolveApiKey } from "./openai.ts"
import { classifyBatch } from "./classify.ts"
import { formatHits, searchMemory } from "./retrieve.ts"

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

  private writeBuf: ChunkInsert[] = []
  private timers: ReturnType<typeof setInterval>[] = []
  private sessionAgent = new Map<string, { agent: string | null; model: string | null }>()
  private planSlug = new Map<string, string | null>()
  private lastRetrieval = new Map<string, { ids: string[]; logId: string }>()
  private archiveBusy = false

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
    this.pForgetSessCt = d.prepare(
      `SELECT count(*) AS c FROM chunk WHERE session_id = ? AND project_id = ?`,
    )
    this.pInsRetrieval = d.prepare(
      `INSERT INTO retrieval_log (id, session_id, query, returned_ids, time_created)
       VALUES (?, ?, ?, ?, ?)`,
    )
    this.pUpsertSessMem = d.prepare(
      `INSERT INTO session_memory_last (session_id, log_id, chunk_ids, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET log_id = excluded.log_id, chunk_ids = excluded.chunk_ids, updated_at = excluded.updated_at`,
    )

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
    const rows = capture.fromMirroredTool(tool, output, sessionID, this.input.project.id, this.cfg, this.planSlug.get(sessionID) ?? null)
    this.enqueue(rows)
    if (tool === "plan" || tool === "journal") {
      const slug = extractSlug(output)
      if (slug) this.planSlug.set(sessionID, slug)
    }

    this.feedbackHook(sessionID, tool, output)
  }

  drainBackfill() {
    if (!this.cfg.enabled || !this.cfg.backfill.enabled) return
    const hp = this.cfg.archive.hotDbPath ?? defaultHotDbPath()
    if (!fs.existsSync(hp)) return
    const hot = new Database(hp, { readonly: true })
    applyConnPragmas(hot)
    const rows = backfillFromHot({
      hot,
      memory: this.db,
      projectId: this.input.project.id,
      cfg: this.cfg,
      batchLimit: 300,
    })
    hot.close()
    if (rows.length) this.enqueue(rows)
  }

  private enqueue(rows: ChunkInsert[]) {
    if (!this.cfg.enabled) return
    for (const r of rows) {
      if (this.writeBuf.length >= this.cfg.embed.queueMax) this.writeBuf.shift()
      const id = ulid()
      r.id = id
      this.writeBuf.push(r)
    }
  }

  private drainWrite() {
    if (this.writeBuf.length === 0) return
    const batch = this.writeBuf.splice(0, 50)
    const exists = this.db.prepare(
      `SELECT 1 FROM chunk WHERE project_id = ? AND content_hash = ? LIMIT 1`,
    )
    const ins = this.db.prepare(
      `INSERT INTO chunk (
        id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
        file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
        time_created, content_hash, root_session_id, session_depth, plan_slug
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    const tx = this.db.transaction((rows: ChunkInsert[]) => {
      for (const r of rows) {
        if (exists.get(r.project_id, r.content_hash)) continue
        ins.run(
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
      }
    })
    tx(batch)
  }

  private async drainEmbed() {
    const key = this.key
    if (!key) return
    const cfg = this.cfg
    const rows = this.pEmbQueue.all(this.input.project.id, cfg.embed.batchSize) as {
      id: string
      content: string
      content_hash: string
      content_type: string
      agent: string | null
    }[]

    if (rows.length === 0) return

    const copyStmt = this.db.prepare(
      `SELECT embedding FROM chunk WHERE content_hash = ? AND embedding IS NOT NULL LIMIT 1`,
    )
    const upd = this.db.prepare(
      `UPDATE chunk SET embedding = ?, time_embedded = ? WHERE id = ?`,
    )

    const need: typeof rows = []
    const now = Date.now()
    for (const r of rows) {
      if (cfg.embed.cacheByHash) {
        const ex = copyStmt.get(r.content_hash) as { embedding: Buffer } | undefined
        if (ex?.embedding) {
          upd.run(ex.embedding, now, r.id)
          continue
        }
      }
      need.push(r)
    }

    if (need.length === 0) return

    let vecs: number[][] = []
    try {
      vecs = await embedTexts({
        key,
        model: cfg.embed.model,
        dimensions: cfg.sidecar.dimensions,
        inputs: need.map((r) => r.content.slice(0, 8000)),
      })
    } catch {
      return
    }

    for (let i = 0; i < need.length; i++) {
      const r = need[i]
      const v = vecs[i]
      if (!r || !v) continue
      const f32 = new Float32Array(v)
      const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
      upd.run(buf, now, r.id)
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
  }

  async memoryTool(query: string, scope: string | undefined, limit: number | undefined, sessionID: string) {
    const key = this.key
    if (!key) throw new Error("OPENAI_API_KEY or engram.openaiApiKey required for memory search")
    const lim = limit ?? 5
    const { hits } = await searchMemory({
      db: this.db,
      cfg: this.cfg,
      projectId: this.input.project.id,
      query,
      scope,
      limit: lim,
      key,
      skipRerank: false,
    })

    const logId = ulid()
    this.pInsRetrieval.run(logId, sessionID, query, JSON.stringify(hits.map((h) => h.id)), Date.now())
    this.lastRetrieval.set(sessionID, { ids: hits.map((h) => h.id), logId })

    this.pUpsertSessMem.run(sessionID, logId, JSON.stringify(hits.map((h) => h.id)), Date.now())

    return formatHits(hits)
  }

  async injectSystem(sessionID: string | undefined, system: string[]): Promise<void> {
    if (!sessionID || !this.cfg.proactive.enabled) return
    const key = this.key
    if (!key) return
    let seed = ""
    try {
      const res = await this.input.client.session.messages({
        path: { id: sessionID },
        query: { directory: this.input.directory, limit: 30 },
      })
      const raw = res as { data?: Array<{ info: { role: string }; parts: Array<{ type?: string; text?: string }> }> }
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

  forgetTool(opts: {
    chunk_ids?: string[]
    session_id?: string
    pattern?: string
    dry_run?: boolean
  }) {
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
          `SELECT c.id FROM chunk_fts f INNER JOIN chunk c ON c.id = f.chunk_id
           WHERE f MATCH ? AND c.project_id = ? LIMIT ?`,
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

  statsTool(report: string | undefined) {
    const pid = this.input.project.id
    const ttl = this.cfg.insights.cacheDays * 86400000
    this.db.prepare(`DELETE FROM friction_cache WHERE time_created < ?`).run(Date.now() - ttl)

    const overview = this.pStatsOverview.get(pid) as { total: number; emb: number }

    const byType = this.pStatsByType.all(pid) as { content_type: string; n: number }[]

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

    return `Report "${report}" not implemented in v1 — use overview | db-health | insights.`
  }

  feedbackHook(sessionID: string, _tool: string, output: string) {
    const last = this.lastRetrieval.get(sessionID)
    if (!last || last.ids.length === 0) return
    const log = this.pLogRef.get(last.logId) as
      | { referenced_ids: string | null }
      | undefined
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
    this.db
      .prepare(`UPDATE retrieval_log SET referenced_ids = ? WHERE id = ?`)
      .run(JSON.stringify([...cited]), last.logId)
  }

  onSessionIdle(ev: { properties?: { sessionID?: string } }) {
    void this.maybeArchive(ev.properties?.sessionID)
  }

  private async maybeArchive(sessionID: string | undefined) {
    if (!sessionID || !this.cfg.archive.onlyWhenIdle || !this.cfg.archive.autoCaptureBefore) return
    if (this.archiveBusy) return
    const hotPath = this.cfg.archive.hotDbPath ?? defaultHotDbPath()
    if (!fs.existsSync(hotPath)) return

    let busy = false
    try {
      const st = await this.input.client.session.status({ query: { directory: this.input.directory } })
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

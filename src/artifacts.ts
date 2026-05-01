import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { Database } from "bun:sqlite"
import { ulid } from "ulid"
import type { EngramConfig } from "./config.ts"
import { contentHash } from "./hash.ts"

export type ArtifactKind = "journal" | "plan" | "audit" | "progress" | "audit_progress" | "status" | "handoff"

export type ArtifactIngestSummary = {
  runId: string
  dryRun: boolean
  discovered: number
  sourcesChanged: number
  items: number
  chunksInserted: number
  errors: string[]
}

type Source = { kind: ArtifactKind; file: string; rel: string }
type Item = {
  kind: ArtifactKind
  title: string | null
  slug: string | null
  content: string
  time: number
}

const authority: Record<ArtifactKind, number> = {
  journal: 10,
  plan: 8,
  audit: 8,
  progress: 7,
  audit_progress: 7,
  handoff: 6,
  status: 3,
}

export function ingestArtifacts(opts: {
  db: Database
  worktree: string
  projectId: string
  cfg: EngramConfig
  dryRun: boolean
  kinds?: string[]
  max?: number
}): ArtifactIngestSummary {
  const runId = ulid()
  const sources = discoverSources(opts.worktree, opts.cfg).filter(
    (s) => !opts.kinds?.length || opts.kinds.includes(s.kind),
  )
  const errors: string[] = []
  let sourcesChanged = 0
  let items = 0
  let chunksInserted = 0
  const max = opts.max ?? Number.POSITIVE_INFINITY

  const sourceRows: Array<{
    source: Source
    hash: string
    mtime: number
    size: number
    parsed: Item[]
  }> = []
  for (const source of sources.slice(0, max)) {
    try {
      const st = statSync(source.file)
      const raw = readFileSync(source.file, "utf8")
      const hash = sha256(raw)
      const existing = opts.db
        .prepare(`SELECT content_hash FROM artifact_source WHERE project_id = ? AND path = ?`)
        .get(opts.projectId, source.rel) as { content_hash: string } | undefined
      const parsed = parseSource(source, raw, st.mtimeMs)
      sourceRows.push({ source, hash, mtime: Math.floor(st.mtimeMs), size: st.size, parsed })
      if (existing?.content_hash !== hash) sourcesChanged++
      items += parsed.length
    } catch (e) {
      errors.push(`${source.rel}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (!opts.dryRun) {
    const now = Date.now()
    const upsertSource = opts.db.prepare(
      `INSERT INTO artifact_source (id, project_id, kind, path, content_hash, mtime_ms, size_bytes, last_ingested_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(project_id, path) DO UPDATE SET
         kind = excluded.kind,
         content_hash = excluded.content_hash,
         mtime_ms = excluded.mtime_ms,
         size_bytes = excluded.size_bytes,
         last_ingested_at = excluded.last_ingested_at`,
    )
    const getSource = opts.db.prepare(`SELECT id FROM artifact_source WHERE project_id = ? AND path = ?`)
    const insertItem = opts.db.prepare(
      `INSERT OR IGNORE INTO artifact_item (
        id, source_id, project_id, kind, title, slug, content, content_hash, authority, time_created, time_updated
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    const existingChunk = opts.db.prepare(`SELECT 1 FROM chunk WHERE project_id = ? AND source_ref = ? LIMIT 1`)
    const insertChunk = opts.db.prepare(
      `INSERT INTO chunk (
        id, session_id, message_id, part_id, project_id, role, agent, model, content_type, content,
        file_paths, tool_name, tool_status, output_head, output_tail, output_length, error_class,
        time_created, content_hash, root_session_id, session_depth, plan_slug,
        source_kind, source_ref, authority
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    const tx = opts.db.transaction(() => {
      for (const row of sourceRows) {
        upsertSource.run(ulid(), opts.projectId, row.source.kind, row.source.rel, row.hash, row.mtime, row.size, now)
        const src = getSource.get(opts.projectId, row.source.rel) as { id: string } | undefined
        if (!src) continue
        for (const item of row.parsed) {
          const h = contentHash(item.content)
          const ref = `artifact:${row.source.rel}:${h}`
          insertItem.run(
            ulid(),
            src.id,
            opts.projectId,
            item.kind,
            item.title,
            item.slug,
            item.content,
            h,
            authority[item.kind],
            item.time,
            now,
          )
          if (existingChunk.get(opts.projectId, ref)) continue
          insertChunk.run(
            ulid(),
            `artifact:${item.kind}`,
            ref,
            null,
            opts.projectId,
            "assistant",
            "engram-artifact",
            null,
            contentType(item.kind, item.content),
            item.content.slice(0, opts.cfg.sidecar.maxChunkLength),
            JSON.stringify([row.source.rel]),
            null,
            null,
            null,
            null,
            null,
            null,
            item.time,
            h,
            null,
            null,
            item.slug,
            item.kind,
            ref,
            authority[item.kind],
          )
          chunksInserted++
        }
      }
      opts.db
        .prepare(
          `INSERT INTO artifact_ingest_run (id, project_id, mode, dry_run, summary_json, time_created) VALUES (?,?,?,?,?,?)`,
        )
        .run(
          runId,
          opts.projectId,
          "artifact",
          0,
          JSON.stringify({ sources: sourceRows.length, items, chunksInserted, errors }),
          now,
        )
    })
    tx()
  }

  return {
    runId,
    dryRun: opts.dryRun,
    discovered: sources.length,
    sourcesChanged,
    items,
    chunksInserted,
    errors,
  }
}

export function formatArtifactIngestSummary(s: ArtifactIngestSummary): string {
  const lines = [
    `Artifact ingest ${s.dryRun ? "dry-run" : "applied"} ${s.runId}`,
    `discovered=${s.discovered} changed=${s.sourcesChanged} items=${s.items} chunksInserted=${s.chunksInserted}`,
  ]
  for (const e of s.errors.slice(0, 10)) lines.push(`error: ${e}`)
  return lines.join("\n")
}

export function discoverSources(worktree: string, cfg: EngramConfig): Source[] {
  const p = cfg.integration.artifactPaths
  return [
    ...walkKind(worktree, p.plans, "plan", [".md"]),
    ...walkKind(worktree, p.audits, "audit", [".md"]),
    ...fileKind(worktree, p.journal, "journal"),
    ...walkKind(worktree, p.progress, "progress", [".json"]),
    ...walkKind(worktree, p.auditProgress, "audit_progress", [".json"]),
    ...walkKind(worktree, p.status, "status", [".json"]),
    ...fileKind(worktree, p.handoff, "handoff"),
  ]
}

function parseSource(source: Source, raw: string, mtime: number): Item[] {
  if (source.kind === "journal") return parseJournal(raw, mtime)
  const title = firstTitle(raw) ?? path.basename(source.rel)
  const slug = path.basename(source.rel).replace(/\.[^.]+$/, "")
  return [{ kind: source.kind, title, slug, content: raw.trim(), time: Math.floor(mtime) }].filter((x) => x.content)
}

function parseJournal(raw: string, mtime: number): Item[] {
  const out: Item[] = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try {
      const row = JSON.parse(t) as Record<string, unknown>
      const body =
        typeof row.content === "string" ? row.content : typeof row.body === "string" ? row.body : JSON.stringify(row)
      const type = typeof row.type === "string" ? row.type : "journal"
      out.push({
        kind: "journal",
        title: type,
        slug: type,
        content: body,
        time: typeof row.time === "number" ? row.time : Math.floor(mtime),
      })
    } catch {
      out.push({
        kind: "journal",
        title: "journal",
        slug: "journal",
        content: t,
        time: Math.floor(mtime),
      })
    }
  }
  return out
}

function contentType(kind: ArtifactKind, content: string): string {
  if (kind === "journal") {
    const t = content.toLowerCase()
    if (t.includes("contract")) return "api_contract"
    if (t.includes("decision")) return "decision"
    if (t.includes("pattern")) return "pattern"
    return "decision"
  }
  if (kind === "audit") return content.toLowerCase().includes("bug") ? "bug" : "analysis"
  if (kind === "plan") return "plan"
  if (kind === "progress" || kind === "audit_progress") return "milestone"
  return "discovery"
}

function walkKind(worktree: string, rel: string, kind: ArtifactKind, exts: string[]): Source[] {
  const root = path.join(worktree, rel)
  if (!existsSync(root)) return []
  const out: Source[] = []
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(file)
      else if (exts.includes(path.extname(ent.name))) out.push({ kind, file, rel: path.relative(worktree, file) })
    }
  }
  walk(root)
  return out
}

function fileKind(worktree: string, rel: string, kind: ArtifactKind): Source[] {
  const file = path.join(worktree, rel)
  return existsSync(file) ? [{ kind, file, rel }] : []
}

function firstTitle(raw: string): string | null {
  for (const line of raw.split(/\r?\n/).slice(0, 20)) {
    const t = line.trim()
    if (t.startsWith("#")) return t.replace(/^#+\s*/, "")
    if (t) return t.slice(0, 120)
  }
  return null
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

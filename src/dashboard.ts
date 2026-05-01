import { existsSync, statSync } from "node:fs"
import type { Database } from "bun:sqlite"
import type { EngramConfig } from "./config.ts"
import { sidecarPath } from "./db.ts"
import { defaultHotDbPath } from "./paths.ts"
import { formatTelemetryReport, recentMetrics } from "./telemetry.ts"

export type DashboardReport = {
  projectId: string
  generatedAt: string
  memory: {
    chunks: number
    embedded: number
    unembedded: number
    byType: Record<string, number>
    sidecarBytes: number | null
    hotBytes: number | null
  }
  archives: {
    rows: number
    checkpoints: number
    bytes: number
  }
  eval: {
    runs: number
    latest: null | {
      fixture: string
      recallAtK: number
      mrr: number
      p50Ms: number
      p95Ms: number
      timeCreated: number
    }
  }
  coverage: {
    artifactSources: number
    artifactItems: number
    rootSessionsIndexed: number
    distillations: number
    relations: number
  }
  embeddingBacklog: {
    oldestAgeHours: number | null
    bySourceKind: Record<string, number>
    byType: Record<string, number>
  }
  telemetry: string
  recommendations: string[]
}

export function buildDashboardReport(opts: {
  db: Database
  projectId: string
  cfg: EngramConfig
  worktree: string
  telemetryLimit?: number
}): DashboardReport {
  const overview = opts.db
    .prepare(
      `SELECT count(*) AS total,
              sum(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded
       FROM chunk WHERE project_id = ?`,
    )
    .get(opts.projectId) as { total: number; embedded: number | null }
  const byTypeRows = opts.db
    .prepare(`SELECT content_type, count(*) AS n FROM chunk WHERE project_id = ? GROUP BY content_type ORDER BY n DESC`)
    .all(opts.projectId) as { content_type: string; n: number }[]
  const archive = opts.db
    .prepare(`SELECT count(*) AS rows, coalesce(sum(archive_size), 0) AS bytes FROM archive WHERE project_id = ?`)
    .get(opts.projectId) as { rows: number; bytes: number }
  const checkpoints = opts.db
    .prepare(`SELECT count(*) AS n FROM export_checkpoint WHERE project_id = ?`)
    .get(opts.projectId) as { n: number }
  const evalOverview = opts.db
    .prepare(`SELECT count(*) AS n FROM eval_run WHERE project_id = ?`)
    .get(opts.projectId) as { n: number }
  const latestEval = opts.db
    .prepare(
      `SELECT fixture_name, recall_at_k, mrr, p50_ms, p95_ms, time_created
       FROM eval_run WHERE project_id = ? ORDER BY time_created DESC LIMIT 1`,
    )
    .get(opts.projectId) as
    | {
        fixture_name: string
        recall_at_k: number
        mrr: number
        p50_ms: number
        p95_ms: number
        time_created: number
      }
    | undefined
  const coverage = {
    artifactSources: scalar(opts.db, `SELECT count(*) AS n FROM artifact_source WHERE project_id = ?`, opts.projectId),
    artifactItems: scalar(opts.db, `SELECT count(*) AS n FROM artifact_item WHERE project_id = ?`, opts.projectId),
    rootSessionsIndexed: scalar(
      opts.db,
      `SELECT count(*) AS n FROM session_root_index WHERE project_id = ?`,
      opts.projectId,
    ),
    distillations: scalar(
      opts.db,
      `SELECT count(*) AS n FROM session_distillation WHERE project_id = ?`,
      opts.projectId,
    ),
    relations: scalar(opts.db, `SELECT count(*) AS n FROM memory_relation WHERE project_id = ?`, opts.projectId),
  }
  const oldestUnembedded = opts.db
    .prepare(`SELECT min(time_created) AS t FROM chunk WHERE project_id = ? AND time_embedded IS NULL`)
    .get(opts.projectId) as { t: number | null }
  const backlogBySource = opts.db
    .prepare(
      `SELECT coalesce(source_kind, 'capture') AS k, count(*) AS n
       FROM chunk WHERE project_id = ? AND time_embedded IS NULL GROUP BY k ORDER BY n DESC LIMIT 8`,
    )
    .all(opts.projectId) as { k: string; n: number }[]
  const backlogByType = opts.db
    .prepare(
      `SELECT content_type AS k, count(*) AS n
       FROM chunk WHERE project_id = ? AND time_embedded IS NULL GROUP BY k ORDER BY n DESC LIMIT 8`,
    )
    .all(opts.projectId) as { k: string; n: number }[]

  const sidecar = sidecarPath(opts.worktree, opts.cfg)
  const hot = opts.cfg.archive.hotDbPath ?? defaultHotDbPath()
  const chunks = overview.total ?? 0
  const embedded = overview.embedded ?? 0
  const report: DashboardReport = {
    projectId: opts.projectId,
    generatedAt: new Date().toISOString(),
    memory: {
      chunks,
      embedded,
      unembedded: chunks - embedded,
      byType: Object.fromEntries(byTypeRows.map((r) => [r.content_type, r.n])),
      sidecarBytes: existsSync(sidecar) ? statSync(sidecar).size : null,
      hotBytes: existsSync(hot) ? statSync(hot).size : null,
    },
    archives: {
      rows: archive.rows,
      checkpoints: checkpoints.n,
      bytes: archive.bytes,
    },
    eval: {
      runs: evalOverview.n,
      latest: latestEval
        ? {
            fixture: latestEval.fixture_name,
            recallAtK: latestEval.recall_at_k,
            mrr: latestEval.mrr,
            p50Ms: latestEval.p50_ms,
            p95Ms: latestEval.p95_ms,
            timeCreated: latestEval.time_created,
          }
        : null,
    },
    coverage,
    embeddingBacklog: {
      oldestAgeHours: oldestUnembedded.t ? (Date.now() - oldestUnembedded.t) / 3600000 : null,
      bySourceKind: Object.fromEntries(backlogBySource.map((r) => [r.k, r.n])),
      byType: Object.fromEntries(backlogByType.map((r) => [r.k, r.n])),
    },
    telemetry: formatTelemetryReport(recentMetrics(opts.db, opts.projectId, opts.telemetryLimit ?? 100), "dashboard"),
    recommendations: [],
  }
  report.recommendations = recommendations(report)
  return report
}

export function formatDashboardReport(report: DashboardReport): string {
  const lines = [
    `Engram dashboard (${report.projectId})`,
    `Generated: ${report.generatedAt}`,
    `Memory: ${report.memory.chunks} chunks | ${report.memory.embedded} embedded | ${report.memory.unembedded} unembedded | sidecar=${fmtBytes(report.memory.sidecarBytes)} hot=${fmtBytes(report.memory.hotBytes)}`,
    `Types: ${Object.entries(report.memory.byType)
      .map(([k, v]) => `${k}=${v}`)
      .join(" | ")}`,
    `Archives: rows=${report.archives.rows} checkpoints=${report.archives.checkpoints} bytes=${fmtBytes(report.archives.bytes)}`,
    report.eval.latest
      ? `Eval: runs=${report.eval.runs} latest=${report.eval.latest.fixture} recall=${pct(report.eval.latest.recallAtK)} mrr=${round(report.eval.latest.mrr)} p95=${round(report.eval.latest.p95Ms)}ms`
      : `Eval: runs=0`,
    `Coverage: artifacts=${report.coverage.artifactSources}/${report.coverage.artifactItems} roots=${report.coverage.rootSessionsIndexed} distillations=${report.coverage.distillations} relations=${report.coverage.relations}`,
    `Embedding backlog: oldest=${report.embeddingBacklog.oldestAgeHours == null ? "n/a" : `${round(report.embeddingBacklog.oldestAgeHours)}h`} bySource=${kv(report.embeddingBacklog.bySourceKind)} byType=${kv(report.embeddingBacklog.byType)}`,
    report.telemetry,
  ]
  if (report.recommendations.length) {
    lines.push("Recommendations:")
    for (const r of report.recommendations) lines.push(`- ${r}`)
  }
  return lines.join("\n")
}

function recommendations(report: DashboardReport): string[] {
  const out: string[] = []
  if (report.memory.chunks > 0 && report.memory.unembedded / report.memory.chunks > 0.25) {
    out.push("Embedding backlog is above 25%; check OpenAI key and embed.drain telemetry.")
  }
  if (report.archives.checkpoints > 0)
    out.push("Archive checkpoints exist; run maintenance/export to finish resumable archives.")
  if (!report.eval.latest) out.push("No eval runs recorded; run `engram eval run --fixture eval/fixtures/core.json`.")
  if (report.eval.latest && report.eval.latest.recallAtK < 0.8)
    out.push("Latest eval recall is below 80%; inspect eval failures.")
  if (report.coverage.artifactSources === 0)
    out.push("No artifact sources ingested; run `engram ingest-artifacts --dry-run`.")
  if (report.coverage.rootSessionsIndexed === 0) out.push("No root sessions indexed; run `engram index-hot --dry-run`.")
  return out
}

function kv(rows: Record<string, number>): string {
  const text = Object.entries(rows)
    .map(([k, v]) => `${k}=${v}`)
    .join(" | ")
  return text || "none"
}

function scalar(db: Database, sql: string, projectId: string): number {
  return (db.prepare(sql).get(projectId) as { n: number }).n ?? 0
}

function fmtBytes(n: number | null): string {
  if (n == null) return "n/a"
  if (n < 1024) return `${n}b`
  if (n < 1024 * 1024) return `${round(n / 1024)}KiB`
  return `${round(n / 1024 / 1024)}MiB`
}

function pct(n: number): string {
  return `${round(n * 100)}%`
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

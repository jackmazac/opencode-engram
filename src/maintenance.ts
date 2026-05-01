import type { Database } from "bun:sqlite"
import type { EngramConfig } from "./config.ts"
import { expandArchivePath } from "./config.ts"
import { exportRootSession, listArchiveRows, staleRootIds, verifyArchiveFile } from "./archive.ts"
import { pruneMetrics } from "./telemetry.ts"

export type MaintenanceOpts = {
  memoryDb: Database
  hotPath: string
  projectId: string
  cfg: EngramConfig
  home: string
  dryRun: boolean
  pruneTelemetry: boolean
  verifyArchives: boolean
  exportStale: boolean
  compactDb: boolean
  healthReport: boolean
}

export async function runMaintenance(opts: MaintenanceOpts): Promise<string> {
  const lines = [`Engram maintenance ${opts.dryRun ? "(dry-run)" : "(apply)"}`]
  if (opts.pruneTelemetry) {
    lines.push(`telemetry prune: retain ${opts.cfg.telemetry.retainDays}d`)
    if (!opts.dryRun) pruneMetrics(opts.memoryDb, opts.projectId, opts.cfg.telemetry.retainDays)
  }

  if (opts.verifyArchives) {
    const rows = listArchiveRows(opts.memoryDb, opts.projectId)
    const root = expandArchivePath(opts.home, opts.cfg.archive)
    let ok = 0
    for (const row of rows) {
      const result = await verifyArchiveFile({
        memoryDb: opts.memoryDb,
        archiveRoot: root,
        projectId: opts.projectId,
        rootSessionId: row.root_session_id,
      })
      if (result.ok) ok++
      else lines.push(`archive verify FAIL ${row.root_session_id}: ${result.detail}`)
    }
    lines.push(`archive verify: ${ok}/${rows.length} ok`)
  }

  if (opts.exportStale) {
    const roots = staleRootIds(opts.hotPath, opts.projectId, opts.cfg.archive.staleDays, Date.now())
    lines.push(`export stale: ${roots.length} root(s)`)
    if (!opts.dryRun) {
      for (const root of roots) {
        const result = await exportRootSession({
          memoryDb: opts.memoryDb,
          hotPath: opts.hotPath,
          projectId: opts.projectId,
          rootSessionId: root,
          cfg: opts.cfg,
          home: opts.home,
          force: false,
        })
        lines.push(`${result.skipped ? "skip" : "export"} ${root} ${result.path ?? ""}`.trim())
      }
    }
  }

  if (opts.compactDb) {
    lines.push("compact sidecar: VACUUM")
    if (!opts.dryRun) opts.memoryDb.run("VACUUM")
  }

  if (opts.healthReport) {
    const chunk = opts.memoryDb
      .prepare(
        `SELECT count(*) AS total,
                sum(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded
         FROM chunk WHERE project_id = ?`,
      )
      .get(opts.projectId) as { total: number; embedded: number | null }
    const checkpoints = opts.memoryDb
      .prepare(`SELECT count(*) AS n FROM export_checkpoint WHERE project_id = ?`)
      .get(opts.projectId) as { n: number }
    const oldest = opts.memoryDb
      .prepare(`SELECT min(time_created) AS t FROM chunk WHERE project_id = ? AND time_embedded IS NULL`)
      .get(opts.projectId) as { t: number | null }
    const age = oldest.t ? `${Math.round(((Date.now() - oldest.t) / 3600000) * 100) / 100}h` : "n/a"
    lines.push(
      `health: chunks=${chunk.total} embedded=${chunk.embedded ?? 0} unembedded=${chunk.total - (chunk.embedded ?? 0)} oldest_unembedded=${age} checkpoints=${checkpoints.n}`,
    )
  }

  return lines.join("\n")
}

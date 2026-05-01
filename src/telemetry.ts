import type { Database } from "bun:sqlite"
import { ulid } from "ulid"

export type MetricStatus = "ok" | "error" | "skip"

export type MemorySnapshot = {
  rss: number
  heapUsed: number
  heapTotal: number
  external: number
  arrayBuffers: number
}

export type MetricInput = {
  projectId: string
  operation: string
  status?: MetricStatus
  durationMs: number
  rowsCount?: number | null
  bytesCount?: number | null
  before?: MemorySnapshot
  after?: MemorySnapshot
  detail?: Record<string, unknown> | null
  timeCreated?: number
  detailMaxLength?: number
}

export type MetricRow = {
  operation: string
  status: string
  duration_ms: number
  rows_count: number | null
  bytes_count: number | null
  heap_used_delta: number | null
  rss_delta: number | null
  detail: string | null
  time_created: number
}

export function memorySnapshot(): MemorySnapshot {
  const m = process.memoryUsage()
  return {
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  }
}

export function recordMetric(db: Database, input: MetricInput) {
  const before = input.before
  const after = input.after
  const detail = input.detail ? truncate(JSON.stringify(input.detail), input.detailMaxLength ?? 2000) : null
  db.prepare(
    `INSERT INTO operation_metric (
      id, project_id, operation, status, duration_ms, rows_count, bytes_count, heap_used_delta, rss_delta, detail, time_created
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    ulid(),
    input.projectId,
    input.operation,
    input.status ?? "ok",
    round(input.durationMs),
    input.rowsCount ?? null,
    input.bytesCount ?? null,
    before && after ? after.heapUsed - before.heapUsed : null,
    before && after ? after.rss - before.rss : null,
    detail,
    input.timeCreated ?? Date.now(),
  )
}

export function pruneMetrics(db: Database, projectId: string, retainDays: number, now = Date.now()) {
  db.prepare(`DELETE FROM operation_metric WHERE project_id = ? AND time_created < ?`).run(
    projectId,
    now - retainDays * 86400000,
  )
}

export function recentMetrics(db: Database, projectId: string, limit: number): MetricRow[] {
  return db
    .prepare(
      `SELECT operation, status, duration_ms, rows_count, bytes_count, heap_used_delta, rss_delta, detail, time_created
       FROM operation_metric
       WHERE project_id = ?
       ORDER BY time_created DESC
       LIMIT ?`,
    )
    .all(projectId, limit) as MetricRow[]
}

export function formatTelemetryReport(rows: MetricRow[], sinceLabel = "recent"): string {
  if (rows.length === 0) return `No telemetry metrics recorded (${sinceLabel}).`

  const groups = new Map<string, MetricRow[]>()
  for (const row of rows) {
    const key = `${row.operation}:${row.status}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }

  const lines = [`Telemetry (${sinceLabel}, ${rows.length} samples)`]
  for (const [key, bucket] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const durations = bucket.map((r) => r.duration_ms).sort((a, b) => a - b)
    const p50 = percentile(durations, 0.5)
    const p95 = percentile(durations, 0.95)
    const max = durations[durations.length - 1] ?? 0
    const rowsCount = bucket.reduce((sum, r) => sum + (r.rows_count ?? 0), 0)
    const heap = bucket.reduce((sum, r) => sum + (r.heap_used_delta ?? 0), 0)
    const rss = bucket.reduce((sum, r) => sum + (r.rss_delta ?? 0), 0)
    lines.push(
      `${key} count=${bucket.length} p50=${round(p50)}ms p95=${round(p95)}ms max=${round(max)}ms rows=${rowsCount} heapΔ=${formatBytes(heap)} rssΔ=${formatBytes(rss)}`,
    )
  }

  const slow = [...rows].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 5)
  lines.push("Slowest:")
  for (const row of slow) {
    lines.push(
      `${new Date(row.time_created).toISOString()} ${row.operation}:${row.status} ${round(row.duration_ms)}ms rows=${row.rows_count ?? 0} ${row.detail ?? ""}`.trim(),
    )
  }

  return lines.join("\n")
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))
  return sorted[idx] ?? 0
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max)
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function formatBytes(n: number): string {
  const sign = n < 0 ? "-" : ""
  const abs = Math.abs(n)
  if (abs < 1024) return `${n}b`
  if (abs < 1024 * 1024) return `${sign}${round(abs / 1024)}KiB`
  return `${sign}${round(abs / 1024 / 1024)}MiB`
}

import type { Database } from "bun:sqlite"
import { ulid } from "ulid"
import type { EngramConfig } from "./config.ts"

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal"

export type LogEventInput = {
  projectId: string
  level: LogLevel
  category: string
  event: string
  operation?: string | null
  status?: string | null
  message?: string | null
  detail?: Record<string, unknown> | null
  durationMs?: number | null
  rowsCount?: number | null
  bytesCount?: number | null
  timeCreated?: number
}

export type LogEventRow = {
  level: LogLevel
  category: string
  event: string
  operation: string | null
  status: string | null
  message: string | null
  detail: string | null
  duration_ms: number | null
  rows_count: number | null
  bytes_count: number | null
  time_created: number
}

export class EngramLogger {
  private insert: ReturnType<Database["prepare"]>
  private minRank: number

  constructor(
    private db: Database,
    private projectId: string,
    private cfg: EngramConfig["telemetry"],
  ) {
    this.insert = db.prepare(
      `INSERT INTO log_event (
        id, project_id, level, category, event, operation, status, message, detail, duration_ms, rows_count, bytes_count, time_created
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.minRank = levelRank(cfg.minLevel)
  }

  event(input: Omit<LogEventInput, "projectId">): void {
    if (!this.cfg.eventsEnabled || levelRank(input.level) < this.minRank) return
    try {
      this.insert.run(
        ulid(),
        this.projectId,
        input.level,
        input.category,
        input.event,
        input.operation ?? null,
        input.status ?? null,
        input.message ?? null,
        serializeDetail(input.detail ?? null, this.cfg.detailMaxLength),
        input.durationMs == null ? null : round(input.durationMs),
        input.rowsCount ?? null,
        input.bytesCount ?? null,
        input.timeCreated ?? Date.now(),
      )
    } catch {
      /* logging must never affect runtime behavior */
    }
  }

  debug(category: string, event: string, detail?: Record<string, unknown>): void {
    this.event({ level: "debug", category, event, detail })
  }

  info(category: string, event: string, detail?: Record<string, unknown>): void {
    this.event({ level: "info", category, event, detail })
  }

  warn(category: string, event: string, detail?: Record<string, unknown>): void {
    this.event({ level: "warn", category, event, detail })
  }

  error(category: string, event: string, error: unknown, detail?: Record<string, unknown>): void {
    this.event({
      level: "error",
      category,
      event,
      message: errorMessage(error),
      detail: { ...(detail ?? {}), error: errorPayload(error) },
    })
  }

  timed<T>(category: string, operation: string, fn: () => T): T {
    const start = performance.now()
    try {
      const result = fn()
      const durationMs = performance.now() - start
      this.maybeSlow(category, operation, "ok", durationMs)
      return result
    } catch (e) {
      const durationMs = performance.now() - start
      this.event({
        level: "error",
        category,
        event: "operation_failed",
        operation,
        status: "error",
        durationMs,
        message: errorMessage(e),
        detail: { error: errorPayload(e) },
      })
      throw e
    }
  }

  async timedAsync<T>(category: string, operation: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now()
    try {
      const result = await fn()
      const durationMs = performance.now() - start
      this.maybeSlow(category, operation, "ok", durationMs)
      return result
    } catch (e) {
      const durationMs = performance.now() - start
      this.event({
        level: "error",
        category,
        event: "operation_failed",
        operation,
        status: "error",
        durationMs,
        message: errorMessage(e),
        detail: { error: errorPayload(e) },
      })
      throw e
    }
  }

  private maybeSlow(category: string, operation: string, status: string, durationMs: number): void {
    if (!this.cfg.logSlowOperations || durationMs < this.cfg.slowMs) return
    this.event({ level: "warn", category, event: "slow_operation", operation, status, durationMs })
  }
}

export function recordLogEvent(db: Database, cfg: EngramConfig["telemetry"], input: LogEventInput): void {
  new EngramLogger(db, input.projectId, cfg).event(input)
}

export function recentLogEvents(
  db: Database,
  projectId: string,
  opts: { limit: number; minLevel?: LogLevel },
): LogEventRow[] {
  const minRank = opts.minLevel ? levelRank(opts.minLevel) : levelRank("debug")
  const rows = db
    .prepare(
      `SELECT level, category, event, operation, status, message, detail, duration_ms, rows_count, bytes_count, time_created
       FROM log_event
       WHERE project_id = ?
       ORDER BY time_created DESC
       LIMIT ?`,
    )
    .all(projectId, opts.limit) as LogEventRow[]
  return rows.filter((row) => levelRank(row.level) >= minRank)
}

export function logEventCounts(
  db: Database,
  projectId: string,
  limit = 500,
): { recent: number; byLevel: Record<string, number>; latest: LogEventRow[] } {
  const latest = recentLogEvents(db, projectId, { limit })
  const byLevel: Record<string, number> = {}
  for (const row of latest) byLevel[row.level] = (byLevel[row.level] ?? 0) + 1
  return { recent: latest.length, byLevel, latest: latest.slice(0, 10) }
}

export function pruneLogEvents(db: Database, projectId: string, retainDays: number, now = Date.now()): void {
  db.prepare(`DELETE FROM log_event WHERE project_id = ? AND time_created < ?`).run(
    projectId,
    now - retainDays * 86400000,
  )
}

export function trimLogEvents(db: Database, projectId: string, maxRows: number): void {
  db.prepare(
    `DELETE FROM log_event
     WHERE project_id = ?
       AND id NOT IN (
         SELECT id FROM log_event WHERE project_id = ? ORDER BY time_created DESC LIMIT ?
       )`,
  ).run(projectId, projectId, maxRows)
}

export function formatEventReport(rows: LogEventRow[], label = "recent events"): string {
  if (rows.length === 0) return `No log events recorded (${label}).`
  const lines = [`Log events (${label}, ${rows.length} samples)`]
  for (const row of rows) {
    const detail = row.detail ? ` ${row.detail}` : ""
    const duration = row.duration_ms == null ? "" : ` ${round(row.duration_ms)}ms`
    lines.push(
      `${new Date(row.time_created).toISOString()} ${row.level.toUpperCase()} ${row.category}.${row.event}${duration} ${row.message ?? ""}${detail}`.trim(),
    )
  }
  return lines.join("\n")
}

function serializeDetail(detail: Record<string, unknown> | null, max: number): string | null {
  if (!detail) return null
  return truncate(JSON.stringify(detail), max)
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { message: String(error) }
}

function levelRank(level: LogLevel): number {
  if (level === "debug") return 10
  if (level === "info") return 20
  if (level === "warn") return 30
  if (level === "error") return 40
  return 50
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

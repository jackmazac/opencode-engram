import type { Database } from "bun:sqlite"

export type ContextBundle = {
  query: string
  decisions: string[]
  plans: string[]
  audits: string[]
  risks: string[]
}

export function buildContextBundle(opts: {
  db: Database
  projectId: string
  query: string
  limit: number
}): ContextBundle {
  const match = ftsQuery(opts.query)
  const rows = queryRows(opts.db, opts.projectId, match, opts.limit)
  const selected = rows.length ? rows : fallbackRows(opts.db, opts.projectId, opts.limit)
  const bundle: ContextBundle = {
    query: opts.query,
    decisions: [],
    plans: [],
    audits: [],
    risks: [],
  }
  for (const row of selected) {
    const line = `[${row.content_type}${row.source_kind ? `/${row.source_kind}` : ""} auth=${row.authority} ${row.id.slice(0, 8)}] ${row.content.replace(/\s+/g, " ").slice(0, 500)}`
    if (["decision", "api_contract", "invariant", "pattern"].includes(row.content_type)) bundle.decisions.push(line)
    else if (row.content_type === "plan") bundle.plans.push(line)
    else if (["analysis", "bug", "test_strategy", "perf_note"].includes(row.content_type)) bundle.audits.push(line)
    else bundle.risks.push(line)
  }
  return bundle
}

type ContextRow = {
  id: string
  content: string
  content_type: string
  source_kind: string | null
  authority: number
}

function queryRows(db: Database, projectId: string, match: string, limit: number): ContextRow[] {
  return db
    .prepare(
      `SELECT c.id, c.content, c.content_type, c.source_kind, c.authority
       FROM chunk_fts
       INNER JOIN chunk c ON c.id = chunk_fts.chunk_id
       WHERE chunk_fts MATCH ? AND c.project_id = ? AND c.superseded_by IS NULL
       ORDER BY c.authority DESC, rank
       LIMIT ?`,
    )
    .all(match, projectId, limit) as ContextRow[]
}

function fallbackRows(db: Database, projectId: string, limit: number): ContextRow[] {
  return db
    .prepare(
      `SELECT id, content, content_type, source_kind, authority
       FROM chunk
       WHERE project_id = ? AND superseded_by IS NULL AND authority >= 7
       ORDER BY authority DESC, time_created DESC
       LIMIT ?`,
    )
    .all(projectId, Math.max(1, Math.min(limit, 12))) as {
    id: string
    content: string
    content_type: string
    source_kind: string | null
    authority: number
  }[]
}

function ftsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_:-]+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 12)
  if (terms.length === 0) return '""'
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ")
}

export function formatContextBundle(bundle: ContextBundle): string {
  return [
    `Engram preflight context: ${bundle.query}`,
    section("Decisions", bundle.decisions),
    section("Plans", bundle.plans),
    section("Audits/Risks", [...bundle.audits, ...bundle.risks]),
  ]
    .filter(Boolean)
    .join("\n")
}

function section(title: string, rows: string[]): string {
  if (!rows.length) return ""
  return [`${title}:`, ...rows.map((r) => `- ${r}`)].join("\n")
}

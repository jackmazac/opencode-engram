import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { ulid } from "ulid"
import { applyConnPragmas } from "./db.ts"

export type RootIndexSummary = {
  roots: number
  indexed: number
  top: Array<{ id: string; title: string; score: number }>
}

type RootRow = { id: string; title: string; time_created: number; time_updated: number }

export function indexHotRoots(opts: {
  db: Database
  hotPath: string
  projectId: string
  max?: number
  dryRun?: boolean
}): RootIndexSummary {
  const hot = new Database(opts.hotPath, { readonly: true })
  applyConnPragmas(hot)
  try {
    const roots = hot
      .prepare(
        `SELECT id, title, time_created, time_updated FROM session WHERE project_id = ? AND parent_id IS NULL ORDER BY time_updated DESC`,
      )
      .all(opts.projectId) as RootRow[]
    const selected = roots.slice(0, opts.max ?? roots.length)
    const indexed = selected.map((r) => summarizeRoot(hot, opts.projectId, r))
    if (!opts.dryRun) upsertRootSummaries(opts.db, opts.projectId, indexed)
    return {
      roots: roots.length,
      indexed: indexed.length,
      top: indexed
        .slice()
        .sort((a, b) => b.priority_score - a.priority_score)
        .slice(0, 10)
        .map((r) => ({ id: r.root_session_id, title: r.title ?? "", score: r.priority_score })),
    }
  } finally {
    hot.close()
  }
}

export function formatRootIndexSummary(s: RootIndexSummary): string {
  const lines = [`Root index: roots=${s.roots} indexed=${s.indexed}`]
  for (const r of s.top) lines.push(`- ${Math.round(r.score)} ${r.id.slice(0, 8)} ${r.title}`)
  return lines.join("\n")
}

type Summary = {
  root_session_id: string
  title: string
  time_created: number
  time_updated: number
  child_count: number
  message_count: number
  part_count: number
  assistant_count: number
  user_count: number
  tool_count: number
  patch_count: number
  reasoning_count: number
  primary_agents_json: string
  priority_score: number
  status: string
  content_hash: string
}

function summarizeRoot(hot: Database, projectId: string, root: RootRow): Summary {
  const sessions = hot
    .prepare(
      `WITH RECURSIVE t(id) AS (
         SELECT id FROM session WHERE id = ? AND project_id = ?
         UNION ALL SELECT s.id FROM session s INNER JOIN t ON s.parent_id = t.id
       ) SELECT id FROM t`,
    )
    .all(root.id, projectId) as { id: string }[]
  const ids = sessions.map((s) => s.id)
  const placeholders = ids.map(() => "?").join(",")
  const messageCount = count(hot, `SELECT count(*) AS c FROM message WHERE session_id IN (${placeholders})`, ids)
  const partRows = hot.prepare(`SELECT data FROM part WHERE session_id IN (${placeholders})`).all(...ids) as {
    data: string
  }[]
  const msgRows = hot.prepare(`SELECT data FROM message WHERE session_id IN (${placeholders})`).all(...ids) as {
    data: string
  }[]

  let tool = 0
  let patch = 0
  let reasoning = 0
  for (const p of partRows) {
    try {
      const data = JSON.parse(p.data) as { type?: string }
      if (data.type === "tool") tool++
      if (data.type === "patch") patch++
      if (data.type === "reasoning") reasoning++
    } catch {
      /* ignore malformed hot rows */
    }
  }

  let assistant = 0
  let user = 0
  const agents = new Map<string, number>()
  for (const m of msgRows) {
    try {
      const data = JSON.parse(m.data) as { role?: string; agent?: string }
      if (data.role === "assistant") assistant++
      if (data.role === "user") user++
      if (data.agent) agents.set(data.agent, (agents.get(data.agent) ?? 0) + 1)
    } catch {
      /* ignore malformed hot rows */
    }
  }

  const primary = [...agents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  const score = priority(root.title, {
    children: ids.length - 1,
    messages: messageCount,
    tool,
    patch,
    reasoning,
    agents: primary,
  })
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        root,
        ids: ids.length,
        messageCount,
        partCount: partRows.length,
        tool,
        patch,
        reasoning,
        primary,
      }),
    )
    .digest("hex")

  return {
    root_session_id: root.id,
    title: root.title,
    time_created: root.time_created,
    time_updated: root.time_updated,
    child_count: Math.max(0, ids.length - 1),
    message_count: messageCount,
    part_count: partRows.length,
    assistant_count: assistant,
    user_count: user,
    tool_count: tool,
    patch_count: patch,
    reasoning_count: reasoning,
    primary_agents_json: JSON.stringify(primary),
    priority_score: score,
    status: "indexed",
    content_hash: hash,
  }
}

function upsertRootSummaries(db: Database, projectId: string, rows: Summary[]) {
  const now = Date.now()
  const stmt = db.prepare(
    `INSERT INTO session_root_index (
      id, project_id, root_session_id, title, time_created, time_updated, child_count, message_count, part_count,
      assistant_count, user_count, tool_count, patch_count, reasoning_count, primary_agents_json, priority_score,
      status, content_hash, indexed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id, root_session_id) DO UPDATE SET
      title = excluded.title,
      time_created = excluded.time_created,
      time_updated = excluded.time_updated,
      child_count = excluded.child_count,
      message_count = excluded.message_count,
      part_count = excluded.part_count,
      assistant_count = excluded.assistant_count,
      user_count = excluded.user_count,
      tool_count = excluded.tool_count,
      patch_count = excluded.patch_count,
      reasoning_count = excluded.reasoning_count,
      primary_agents_json = excluded.primary_agents_json,
      priority_score = excluded.priority_score,
      status = excluded.status,
      content_hash = excluded.content_hash,
      indexed_at = excluded.indexed_at`,
  )
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmt.run(
        ulid(),
        projectId,
        r.root_session_id,
        r.title,
        r.time_created,
        r.time_updated,
        r.child_count,
        r.message_count,
        r.part_count,
        r.assistant_count,
        r.user_count,
        r.tool_count,
        r.patch_count,
        r.reasoning_count,
        r.primary_agents_json,
        r.priority_score,
        r.status,
        r.content_hash,
        now,
      )
    }
  })
  tx()
}

function priority(
  title: string,
  s: {
    children: number
    messages: number
    tool: number
    patch: number
    reasoning: number
    agents: [string, number][]
  },
): number {
  let score = Math.min(50, s.children) + Math.min(30, s.messages / 100)
  if (/audit|plan|fix|review|phase|remediation|migration/i.test(title)) score += 25
  if (s.agents.some(([a]) => /reviewer|scribe|validator/i.test(a))) score += 15
  if (s.patch > 0) score += 10
  if (s.tool > s.messages * 2) score -= 15
  if (s.reasoning > s.messages) score -= 5
  return Math.max(0, score)
}

function count(db: Database, sql: string, args: string[]): number {
  return (db.prepare(sql).get(...args) as { c: number }).c ?? 0
}

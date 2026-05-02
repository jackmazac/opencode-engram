import type { Database } from "bun:sqlite"

export type ContextMode = "plan" | "implement" | "review" | "debug" | "audit" | "handoff"

export type ContextSectionId =
  | "must_know"
  | "relevant_past_work"
  | "current_risks"
  | "prior_successful_paths"
  | "evidence"
  | "suggested_next_steps"

export type WorkspaceSignals = {
  changedFiles?: string[]
  branch?: string | null
}

export type ContextBundleItem = {
  id: string
  source: "chunk" | "artifact" | "root" | "distillation" | "suggestion"
  section: ContextSectionId
  type: string
  title: string | null
  sourceKind: string | null
  authority: number
  score: number
  text: string
  matchedTerms: string[]
  reasons: string[]
  evidenceIds: string[]
  rootSessionId: string | null
}

export type ContextBundleSection = {
  id: ContextSectionId
  title: string
  items: ContextBundleItem[]
}

export type ContextBundle = {
  query: string
  mode: ContextMode
  generatedAt: string
  terms: string[]
  workspaceSignals?: WorkspaceSignals
  sections: ContextBundleSection[]
  suggestedNextSteps: string[]
}

type Candidate = Omit<ContextBundleItem, "section" | "score" | "reasons"> & {
  baseScore: number
  timeCreated: number | null
  reasons: string[]
}

const sectionTitles: Record<ContextSectionId, string> = {
  must_know: "Must Know",
  relevant_past_work: "Relevant Past Work",
  current_risks: "Current Risks",
  prior_successful_paths: "Prior Successful Paths",
  evidence: "Evidence",
  suggested_next_steps: "Suggested Next Steps",
}

export function buildContextBundle(opts: {
  db: Database
  projectId: string
  query: string
  limit: number
  mode?: ContextMode
  workspaceSignals?: WorkspaceSignals
  budgetChars?: number
}): ContextBundle {
  const mode = opts.mode ?? "plan"
  const terms = expandTerms(opts.query, opts.workspaceSignals)
  const limit = Math.max(1, Math.min(opts.limit, 50))
  const candidates = [
    ...rootCandidates(opts.db, opts.projectId, terms, limit),
    ...artifactCandidates(opts.db, opts.projectId, terms, limit),
    ...distillationCandidates(opts.db, opts.projectId, terms, limit),
    ...chunkCandidates(opts.db, opts.projectId, terms, limit * 2),
  ]
  const ranked = rankCandidates(dedupeCandidates(candidates), mode, opts.workspaceSignals)
  const sections = buildSections(ranked, mode, limit, opts.budgetChars ?? 6000)
  const suggestedNextSteps = suggestedSteps(sections, mode)

  if (suggestedNextSteps.length) {
    sections.push({
      id: "suggested_next_steps",
      title: sectionTitles.suggested_next_steps,
      items: suggestedNextSteps.map((text, i) => ({
        id: `suggestion:${i + 1}`,
        source: "suggestion" as const,
        section: "suggested_next_steps" as const,
        type: "suggestion",
        title: null,
        sourceKind: null,
        authority: 0,
        score: 0,
        text,
        matchedTerms: [],
        reasons: ["rule-based next step"],
        evidenceIds: [],
        rootSessionId: null,
      })),
    })
  }

  return {
    query: opts.query,
    mode,
    generatedAt: new Date().toISOString(),
    terms,
    workspaceSignals: opts.workspaceSignals,
    sections,
    suggestedNextSteps,
  }
}

function rootCandidates(db: Database, projectId: string, terms: string[], limit: number): Candidate[] {
  const rows = db
    .prepare(
      `SELECT root_session_id, title, priority_score, primary_agents_json, time_updated
       FROM session_root_index
       WHERE project_id = ?
       ORDER BY priority_score DESC, time_updated DESC
       LIMIT ?`,
    )
    .all(projectId, Math.max(limit * 4, 20)) as {
    root_session_id: string
    title: string | null
    priority_score: number
    primary_agents_json: string
    time_updated: number | null
  }[]

  return rows.flatMap((row) => {
    const text = `${row.title ?? row.root_session_id} ${row.primary_agents_json}`
    const matchedTerms = matched(text, terms)
    if (terms.length && matchedTerms.length === 0) return []
    return [
      {
        id: row.root_session_id,
        source: "root" as const,
        type: "root_session",
        title: row.title,
        sourceKind: "hot_root",
        authority: 7,
        baseScore: 14 + Math.min(12, row.priority_score / 10) + matchedTerms.length * 5,
        text: `Root session: ${row.title ?? row.root_session_id}`,
        matchedTerms,
        reasons: ["root session index", `priority=${Math.round(row.priority_score)}`],
        evidenceIds: [row.root_session_id],
        rootSessionId: row.root_session_id,
        timeCreated: row.time_updated,
      },
    ]
  })
}

function artifactCandidates(db: Database, projectId: string, terms: string[], limit: number): Candidate[] {
  const rows = db
    .prepare(
      `SELECT id, kind, title, slug, content, authority, time_updated
       FROM artifact_item
       WHERE project_id = ?
       ORDER BY authority DESC, time_updated DESC
       LIMIT ?`,
    )
    .all(projectId, Math.max(limit * 6, 30)) as {
    id: string
    kind: string
    title: string | null
    slug: string | null
    content: string
    authority: number
    time_updated: number | null
  }[]
  return rows.flatMap((row) => {
    const matchedTerms = matched(`${row.title ?? ""} ${row.slug ?? ""} ${row.content}`, terms)
    if (terms.length && matchedTerms.length === 0) return []
    return [
      {
        id: row.id,
        source: "artifact" as const,
        type: artifactType(row.kind, row.content),
        title: row.title ?? row.slug,
        sourceKind: row.kind,
        authority: row.authority,
        baseScore: 20 + row.authority * 2 + matchedTerms.length * 5,
        text: row.content,
        matchedTerms,
        reasons: [`${row.kind} artifact`, `authority=${row.authority}`],
        evidenceIds: [row.id],
        rootSessionId: null,
        timeCreated: row.time_updated,
      },
    ]
  })
}

function distillationCandidates(db: Database, projectId: string, terms: string[], limit: number): Candidate[] {
  const rows = db
    .prepare(
      `SELECT root_session_id, summary_json, token_estimate, time_created
       FROM session_distillation
       WHERE project_id = ?
       ORDER BY time_created DESC
       LIMIT ?`,
    )
    .all(projectId, Math.max(limit * 4, 20)) as {
    root_session_id: string
    summary_json: string
    token_estimate: number
    time_created: number
  }[]
  return rows.flatMap((row) => {
    const summary = safeSummary(row.summary_json)
    const matchedTerms = matched(summary, terms)
    if (terms.length && matchedTerms.length === 0) return []
    return [
      {
        id: `distill:${row.root_session_id}`,
        source: "distillation" as const,
        type: "synthesis",
        title: null,
        sourceKind: "distillation",
        authority: 9,
        baseScore: 18 + matchedTerms.length * 5,
        text: summary,
        matchedTerms,
        reasons: ["root distillation", "authority=9"],
        evidenceIds: [row.root_session_id],
        rootSessionId: row.root_session_id,
        timeCreated: row.time_created,
      },
    ]
  })
}

function chunkCandidates(db: Database, projectId: string, terms: string[], limit: number): Candidate[] {
  const rows = terms.length
    ? queryChunkRows(db, projectId, ftsQuery(terms), limit)
    : fallbackChunkRows(db, projectId, limit)
  const selected = rows.length ? rows : fallbackChunkRows(db, projectId, limit)
  return selected.map((row) => {
    const matchedTerms = matched(row.content, terms)
    return {
      id: row.id,
      source: "chunk" as const,
      type: row.content_type,
      title: null,
      sourceKind: row.source_kind,
      authority: row.authority,
      baseScore: 10 + row.authority * 2 + matchedTerms.length * 5 + (row.rankScore ?? 0),
      text: row.content,
      matchedTerms,
      reasons: [row.source_kind ? `${row.source_kind} memory` : "memory chunk", `authority=${row.authority}`],
      evidenceIds: [row.id],
      rootSessionId: row.root_session_id,
      timeCreated: row.time_created,
    }
  })
}

function queryChunkRows(db: Database, projectId: string, match: string, limit: number): ChunkRow[] {
  return db
    .prepare(
      `SELECT c.id, c.content, c.content_type, c.source_kind, c.authority, c.root_session_id, c.time_created, rank AS rank_score
       FROM chunk_fts
       INNER JOIN chunk c ON c.id = chunk_fts.chunk_id
       WHERE chunk_fts MATCH ? AND c.project_id = ? AND c.superseded_by IS NULL
       ORDER BY c.authority DESC, rank
       LIMIT ?`,
    )
    .all(match, projectId, limit) as ChunkRow[]
}

function fallbackChunkRows(db: Database, projectId: string, limit: number): ChunkRow[] {
  return db
    .prepare(
      `SELECT id, content, content_type, source_kind, authority, root_session_id, time_created, 0 AS rank_score
       FROM chunk
       WHERE project_id = ? AND superseded_by IS NULL AND authority >= 7
       ORDER BY authority DESC, time_created DESC
       LIMIT ?`,
    )
    .all(projectId, Math.max(1, Math.min(limit, 24))) as ChunkRow[]
}

type ChunkRow = {
  id: string
  content: string
  content_type: string
  source_kind: string | null
  authority: number
  root_session_id: string | null
  time_created: number | null
  rankScore?: number
  rank_score?: number
}

function rankCandidates(
  candidates: Candidate[],
  mode: ContextMode,
  signals: WorkspaceSignals | undefined,
): ContextBundleItem[] {
  return candidates
    .map((c) => {
      const modeBoost = modeTypeBoost(mode, c.type, c.source)
      const workspaceBoost = workspaceSignalBoost(c, signals)
      const lowValuePenalty = c.type === "tool_trace" ? -8 : 0
      const score = c.baseScore + modeBoost + workspaceBoost + lowValuePenalty
      const reasons = [
        ...c.reasons,
        ...(c.matchedTerms.length ? [`matched ${c.matchedTerms.join(", ")}`] : []),
        modeBoost ? `${mode} mode boost` : "",
        workspaceBoost ? "workspace signal match" : "",
        c.type === "tool_trace" ? "tool_trace demoted" : "",
        "not superseded",
      ].filter(Boolean)
      return { ...c, score, section: routeSection(mode, c), reasons }
    })
    .sort((a, b) => b.score - a.score || b.authority - a.authority)
}

function buildSections(
  items: ContextBundleItem[],
  mode: ContextMode,
  limit: number,
  budgetChars: number,
): ContextBundleSection[] {
  const sectionIds: ContextSectionId[] = [
    "must_know",
    "relevant_past_work",
    "current_risks",
    "prior_successful_paths",
    "evidence",
  ]
  const buckets = new Map<ContextSectionId, ContextBundleItem[]>(sectionIds.map((id) => [id, []]))
  let used = 0
  for (const item of items) {
    if (used >= budgetChars) break
    const bucket = buckets.get(item.section) ?? buckets.get("evidence")
    if (!bucket || bucket.length >= perSectionLimit(item.section, mode, limit)) continue
    const clipped = { ...item, text: compact(item.text, 700) }
    used += clipped.text.length
    bucket.push(clipped)
  }
  return sectionIds.flatMap((id) => {
    const rows = buckets.get(id) ?? []
    return rows.length ? [{ id, title: sectionTitles[id], items: rows }] : []
  })
}

function perSectionLimit(section: ContextSectionId, mode: ContextMode, limit: number): number {
  if (section === "must_know") return Math.max(3, Math.ceil(limit * 0.35))
  if (section === "current_risks" && (mode === "review" || mode === "debug" || mode === "audit")) return 5
  if (section === "evidence") return 4
  return Math.max(2, Math.ceil(limit * 0.25))
}

function routeSection(mode: ContextMode, c: Candidate): ContextSectionId {
  if (["decision", "api_contract", "invariant", "product_requirement", "pattern"].includes(c.type)) return "must_know"
  if (mode === "plan" && ["bug", "analysis", "test_strategy", "perf_note"].includes(c.type)) return "current_risks"
  if (mode === "review" && ["bug", "test_strategy", "error", "analysis"].includes(c.type)) return "current_risks"
  if (mode === "debug" && ["bug", "error", "perf_note"].includes(c.type)) return "current_risks"
  if (mode === "audit" && ["analysis", "bug", "product_requirement"].includes(c.type)) return "current_risks"
  if (["migration", "test_strategy", "perf_note"].includes(c.type)) return "prior_successful_paths"
  if (c.source === "root" || c.source === "distillation" || c.type === "plan" || c.type === "milestone")
    return "relevant_past_work"
  return "evidence"
}

function modeTypeBoost(mode: ContextMode, type: string, source: ContextBundleItem["source"]): number {
  const plan = new Set(["decision", "api_contract", "invariant", "plan", "analysis", "product_requirement"])
  const implement = new Set(["api_contract", "invariant", "migration", "test_strategy", "perf_note", "synthesis"])
  const review = new Set(["bug", "test_strategy", "invariant", "api_contract", "analysis"])
  const debug = new Set(["bug", "error", "perf_note", "synthesis"])
  const audit = new Set(["analysis", "bug", "product_requirement", "synthesis"])
  const handoff = new Set(["plan", "milestone", "decision", "synthesis"])
  const map = { plan, implement, review, debug, audit, handoff }
  let boost = map[mode].has(type) ? 12 : 0
  if ((mode === "plan" || mode === "audit") && source === "root") boost += 6
  if ((mode === "implement" || mode === "handoff") && source === "distillation") boost += 6
  return boost
}

function workspaceSignalBoost(c: Candidate, signals: WorkspaceSignals | undefined): number {
  if (!signals) return 0
  const terms = [
    ...(signals.changedFiles ?? []).flatMap(tokenize),
    ...(signals.branch ? tokenize(signals.branch) : []),
  ].slice(0, 40)
  if (!terms.length) return 0
  const haystack = `${c.title ?? ""} ${c.text} ${c.sourceKind ?? ""}`.toLowerCase()
  return Math.min(10, matched(haystack, terms).length * 2)
}

function suggestedSteps(sections: ContextBundleSection[], mode: ContextMode): string[] {
  const out: string[] = []
  if (!sections.some((s) => s.id === "must_know"))
    out.push("No high-authority decisions/contracts matched; broaden query or ingest artifacts.")
  if (mode === "review" && sections.some((s) => s.id === "current_risks"))
    out.push("Check current risks before approving changes.")
  if (mode === "plan" && sections.some((s) => s.id === "relevant_past_work"))
    out.push("Reuse relevant prior plan/audit context before drafting new work.")
  if (mode === "debug" && sections.some((s) => s.id === "prior_successful_paths"))
    out.push("Compare against prior successful fixes before changing code.")
  return out.slice(0, 3)
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const c of candidates) {
    const key = `${c.source}:${c.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

function artifactType(kind: string, content: string): string {
  if (kind === "journal") {
    const t = content.toLowerCase()
    if (t.includes("contract")) return "api_contract"
    if (t.includes("pattern")) return "pattern"
    return "decision"
  }
  if (kind === "plan") return "plan"
  if (kind === "audit") return content.toLowerCase().includes("bug") ? "bug" : "analysis"
  if (kind === "progress" || kind === "audit_progress") return "milestone"
  return "discovery"
}

function safeSummary(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { content?: string; title?: string }
    return parsed.content ?? parsed.title ?? raw
  } catch {
    return raw
  }
}

function expandTerms(query: string, signals: WorkspaceSignals | undefined): string[] {
  const terms = new Set(tokenize(query))
  for (const term of [...terms]) for (const extra of expansionMap[term] ?? []) terms.add(extra)
  for (const file of signals?.changedFiles ?? []) for (const term of tokenize(file)) terms.add(term)
  if (signals?.branch) for (const term of tokenize(signals.branch)) terms.add(term)
  return [...terms].filter((x) => x.length > 1).slice(0, 32)
}

const expansionMap: Record<string, string[]> = {
  brief: ["persistence", "auto", "update", "connector", "meeting"],
  task: ["tasks", "background", "queue", "worker", "status", "agent"],
  tasks: ["background", "queue", "worker", "status", "agent"],
  workspace: ["tree", "node", "artifact", "folder", "scope"],
  review: ["finding", "findings", "failed", "regression", "test"],
  latency: ["network", "timeout", "streaming", "transport"],
  auth: ["session", "token", "permission", "security"],
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_:-]+/)
    .map((term) => term.trim())
    .filter(Boolean)
}

function matched(text: string, terms: string[]): string[] {
  const haystack = text.toLowerCase()
  const out: string[] = []
  for (const term of terms) if (haystack.includes(term) && !out.includes(term)) out.push(term)
  return out.slice(0, 8)
}

function ftsQuery(terms: string): string
function ftsQuery(terms: string[]): string
function ftsQuery(terms: string | string[]): string {
  const list = Array.isArray(terms) ? terms : tokenize(terms)
  const filtered = list.filter(Boolean).slice(0, 16)
  if (filtered.length === 0) return '""'
  return filtered.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ")
}

function compact(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim()
  if (oneLine.length <= n) return oneLine
  return oneLine.slice(0, n)
}

export function formatContextBundle(bundle: ContextBundle): string {
  const lines = [`Engram preflight context (${bundle.mode}): ${bundle.query}`]
  for (const section of bundle.sections) {
    if (!section.items.length) continue
    lines.push(`${section.title}:`)
    for (const item of section.items) {
      lines.push(
        `- [${item.type}${item.sourceKind ? `/${item.sourceKind}` : ""} auth=${item.authority} score=${Math.round(item.score)} ${item.id.slice(0, 12)}] ${compact(item.text, 500)}`,
      )
      lines.push(`  why: ${item.reasons.join("; ")}`)
    }
  }
  return lines.join("\n")
}

import path from "node:path"
import fs from "node:fs"
import stripJsonComments from "strip-json-comments"
import { z } from "zod"

const sidecar = z.object({
  path: z.string().default(".opencode/memory.db"),
  dimensions: z.union([z.literal(256), z.literal(512), z.literal(1024), z.literal(1536)]).default(256),
  maxChunkLength: z.number().int().positive().default(2000),
})

const capture = z.object({
  assistantText: z.boolean().default(true),
  reasoning: z.boolean().default(false),
  toolTraces: z.boolean().default(true),
  toolOutputHead: z.number().int().nonnegative().default(200),
  toolOutputTail: z.number().int().nonnegative().default(500),
  journalMirror: z.boolean().default(true),
  planMirror: z.boolean().default(true),
  skipPartTypes: z.array(z.string()).default(["step-start", "step-finish", "snapshot"]),
  extraPartTypes: z.array(z.string()).default([]),
  /** When non-empty, only these `part.type` values are captured (others skipped). */
  allowPartTypes: z.array(z.string()).default([]),
  policy: z
    .object({
      denyToolNames: z.array(z.string()).default(["read", "grep", "glob"]),
      captureCompletedToolOutput: z.boolean().default(false),
      captureErrorToolOutput: z.boolean().default(true),
      maxToolOutputLength: z.number().int().nonnegative().default(10_000),
    })
    .default({
      denyToolNames: ["read", "grep", "glob"],
      captureCompletedToolOutput: false,
      captureErrorToolOutput: true,
      maxToolOutputLength: 10_000,
    }),
})

const classify = z.object({
  model: z.string().default("gpt-5.4-nano"),
  enabled: z.boolean().default(true),
  typeProposalThreshold: z.number().int().positive().default(10),
})

const embed = z.object({
  model: z.string().default("text-embedding-3-small"),
  batchSize: z.number().int().positive().max(2048).default(100),
  intervalMs: z.number().int().positive().default(5000),
  queueMax: z.number().int().positive().default(500),
  cacheByHash: z.boolean().default(true),
})

const rerank = z.object({
  model: z.string().default("gpt-5.4-nano"),
  candidates: z.number().int().positive().default(20),
  enabled: z.boolean().default(true),
})

const proactive = z.object({
  enabled: z.boolean().default(true),
  maxTokens: z.number().int().positive().default(2000),
  maxChunks: z.number().int().positive().default(5),
  skipRerank: z.boolean().default(true),
})

const archive = z.object({
  path: z.string().default("~/.opencode/archives"),
  staleDays: z.number().int().nonnegative().default(30),
  autoCaptureBefore: z.boolean().default(true),
  exportTimeoutMs: z.number().int().positive().default(120_000),
  batchSize: z.number().int().positive().default(500),
  onlyWhenIdle: z.boolean().default(true),
  hotDbPath: z.string().optional(),
})

const insights = z.object({
  model: z.string().default("gpt-5.4-nano"),
  cacheDays: z.number().int().positive().default(1),
  lookbackDays: z.number().int().positive().default(30),
})

const memorySearch = z.object({
  recentDays: z.number().int().positive().default(7),
  recentChunkLimit: z.number().int().positive().default(5000),
  kFts: z.number().int().positive().default(50),
  kVec: z.number().int().positive().default(30),
  kRerank: z.number().int().positive().default(20),
  scopeIncludeUnembeddedGraceHours: z.number().nonnegative().default(24),
  forgetPatternMaxRows: z.number().int().positive().default(500),
})

const backfillCfg = z.object({
  enabled: z.boolean().default(true),
  lookbackDays: z.number().int().positive().default(90),
  auto: z.boolean().default(true),
  repeat: z.boolean().default(false),
  intervalMs: z.number().int().positive().default(60_000),
  startupDelayMs: z.number().int().nonnegative().default(60_000),
})

const telemetry = z.object({
  enabled: z.boolean().default(true),
  slowMs: z.number().int().positive().default(250),
  detailMaxLength: z.number().int().positive().default(2000),
  retainDays: z.number().int().positive().default(14),
  eventsEnabled: z.boolean().default(true),
  eventRetainDays: z.number().int().positive().default(14),
  eventMaxRows: z.number().int().positive().default(5000),
  minLevel: z.enum(["debug", "info", "warn", "error", "fatal"]).default("info"),
  logSlowOperations: z.boolean().default(true),
  logZeroResultSearches: z.boolean().default(false),
})

const integration = z.object({
  profile: z.enum(["standalone", "opencode-artifacts", "orchestrator"]).default("standalone"),
  artifactPaths: z
    .object({
      plans: z.string().default(".opencode/plans"),
      audits: z.string().default(".opencode/audits"),
      journal: z.string().default(".opencode/journal.jsonl"),
      progress: z.string().default(".opencode/progress"),
      auditProgress: z.string().default(".opencode/audit-progress"),
      status: z.string().default(".opencode/status"),
      handoff: z.string().default(".opencode/handoff.md"),
    })
    .default({
      plans: ".opencode/plans",
      audits: ".opencode/audits",
      journal: ".opencode/journal.jsonl",
      progress: ".opencode/progress",
      auditProgress: ".opencode/audit-progress",
      status: ".opencode/status",
      handoff: ".opencode/handoff.md",
    }),
})

const hints = z.object({
  /** Append a short <engram-hint> to system for root sessions only (no parentID). Like DCP, skips internal agent signatures. */
  orchestrator: z.boolean().default(true),
})

export const EngramConfig = z.object({
  enabled: z.boolean().default(true),
  openaiApiKey: z.string().optional(),
  sidecar,
  capture,
  classify,
  embed,
  rerank,
  proactive,
  hints,
  archive,
  insights,
  memorySearch,
  backfill: backfillCfg,
  telemetry,
  integration,
})

export type EngramConfig = z.infer<typeof EngramConfig>

/** Fully-resolved defaults (use when not reading from disk). */
export const defaultEngramConfig = EngramConfig.parse({
  enabled: true,
  sidecar: {
    path: ".opencode/memory.db",
    dimensions: 256,
    maxChunkLength: 2000,
  },
  capture: {
    assistantText: true,
    reasoning: false,
    toolTraces: true,
    toolOutputHead: 200,
    toolOutputTail: 500,
    journalMirror: true,
    planMirror: true,
    skipPartTypes: ["step-start", "step-finish", "snapshot"],
    extraPartTypes: [],
    allowPartTypes: [],
    policy: {
      denyToolNames: ["read", "grep", "glob"],
      captureCompletedToolOutput: false,
      captureErrorToolOutput: true,
      maxToolOutputLength: 10_000,
    },
  },
  classify: {
    model: "gpt-5.4-nano",
    enabled: true,
    typeProposalThreshold: 10,
  },
  embed: {
    model: "text-embedding-3-small",
    batchSize: 100,
    intervalMs: 5000,
    queueMax: 500,
    cacheByHash: true,
  },
  rerank: {
    model: "gpt-5.4-nano",
    candidates: 20,
    enabled: true,
  },
  proactive: {
    enabled: true,
    maxTokens: 2000,
    maxChunks: 5,
    skipRerank: true,
  },
  hints: {
    orchestrator: true,
  },
  archive: {
    path: "~/.opencode/archives",
    staleDays: 30,
    autoCaptureBefore: true,
    exportTimeoutMs: 120_000,
    batchSize: 500,
    onlyWhenIdle: true,
  },
  insights: {
    model: "gpt-5.4-nano",
    cacheDays: 1,
    lookbackDays: 30,
  },
  memorySearch: {
    recentDays: 7,
    recentChunkLimit: 5000,
    kFts: 50,
    kVec: 30,
    kRerank: 20,
    scopeIncludeUnembeddedGraceHours: 24,
    forgetPatternMaxRows: 500,
  },
  backfill: {
    enabled: true,
    lookbackDays: 90,
    auto: true,
    repeat: false,
    intervalMs: 60_000,
    startupDelayMs: 60_000,
  },
  telemetry: {
    enabled: true,
    slowMs: 250,
    detailMaxLength: 2000,
    retainDays: 14,
    eventsEnabled: true,
    eventRetainDays: 14,
    eventMaxRows: 5000,
    minLevel: "info",
    logSlowOperations: true,
    logZeroResultSearches: false,
  },
  integration: {
    profile: "standalone",
    artifactPaths: {
      plans: ".opencode/plans",
      audits: ".opencode/audits",
      journal: ".opencode/journal.jsonl",
      progress: ".opencode/progress",
      auditProgress: ".opencode/audit-progress",
      status: ".opencode/status",
      handoff: ".opencode/handoff.md",
    },
  },
})

export function loadConfig(worktree: string): EngramConfig {
  const p = path.join(worktree, ".opencode", "engram.jsonc")
  if (!fs.existsSync(p)) {
    const alt = path.join(worktree, ".opencode", "engram.json")
    if (!fs.existsSync(alt)) return defaultEngramConfig
    return mergeFile(alt)
  }
  return mergeFile(p)
}

function record(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x)
}

function mergeDeep(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base
  if (!record(patch)) return patch
  if (!record(base)) {
    const o: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch)) o[k] = mergeDeep(undefined, v)
    return o
  }
  const o = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    o[k] = mergeDeep(base[k], v)
  }
  return o
}

function mergeFile(file: string): EngramConfig {
  const raw = fs.readFileSync(file, "utf8")
  const json: unknown = JSON.parse(stripJsonComments(raw))
  const merged = mergeDeep(defaultEngramConfig, json)
  const out = EngramConfig.safeParse(merged)
  if (!out.success) throw out.error
  return out.data
}

export function expandArchivePath(home: string, cfg: EngramConfig["archive"]): string {
  if (cfg.path.startsWith("~/")) return path.join(home, cfg.path.slice(2))
  if (cfg.path === "~") return home
  return cfg.path
}

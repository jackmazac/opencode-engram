import { z } from "zod"

export const bridgeArtifactSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("plan"),
    slug: z.string(),
    title: z.string(),
    status: z.enum(["draft", "active", "done", "archived"]).default("active"),
    body: z.string(),
    updatedAt: z.number().optional(),
  }),
  z.object({
    kind: z.literal("audit"),
    slug: z.string(),
    title: z.string(),
    status: z.enum(["open", "done", "archived"]).default("open"),
    body: z.string(),
    updatedAt: z.number().optional(),
  }),
  z.object({
    kind: z.literal("journal"),
    type: z.enum(["decision", "contract", "pattern", "discovery"]),
    body: z.string(),
    slug: z.string().optional(),
    updatedAt: z.number().optional(),
  }),
  z.object({
    kind: z.literal("review"),
    verdict: z.enum(["pass", "fail", "pass_with_fixes", "comment"]),
    body: z.string(),
    findings: z.array(z.unknown()).default([]),
    planSlug: z.string().optional(),
    updatedAt: z.number().optional(),
  }),
  z.object({
    kind: z.literal("wave_progress"),
    planSlug: z.string(),
    waveId: z.string(),
    status: z.enum(["pending", "in-progress", "done", "blocked", "cancelled"]),
    summary: z.string(),
    updatedAt: z.number().optional(),
  }),
])

export type BridgeArtifact = z.infer<typeof bridgeArtifactSchema>

export const contextBundleRequestSchema = z.object({
  projectId: z.string(),
  query: z.string(),
  mode: z.enum(["plan", "implement", "review", "debug", "audit", "handoff"]).default("plan"),
  limit: z.number().int().positive().default(12),
  budgetChars: z.number().int().positive().optional(),
  includeKinds: z.array(z.string()).optional(),
  workspaceSignals: z
    .object({
      changedFiles: z.array(z.string()).optional(),
      branch: z.string().nullable().optional(),
    })
    .optional(),
})

export type ContextBundleRequest = z.infer<typeof contextBundleRequestSchema>

export type ContextMode = ContextBundleRequest["mode"]

export type ContextBundleSection = {
  id:
    | "must_know"
    | "relevant_past_work"
    | "current_risks"
    | "prior_successful_paths"
    | "evidence"
    | "suggested_next_steps"
  title: string
  items: Array<{
    id: string
    source: "chunk" | "artifact" | "root" | "distillation" | "suggestion"
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
  }>
}

export type ContextBundleResponse = {
  query: string
  mode: ContextMode
  generatedAt: string
  terms: string[]
  sections: ContextBundleSection[]
  suggestedNextSteps: string[]
}

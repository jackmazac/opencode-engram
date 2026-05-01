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
  limit: z.number().int().positive().default(12),
  includeKinds: z.array(z.string()).optional(),
})

export type ContextBundleRequest = z.infer<typeof contextBundleRequestSchema>

export type ContextBundleSection = {
  title: string
  items: Array<{
    id: string
    type: string
    sourceKind: string | null
    authority: number
    text: string
  }>
}

export type ContextBundleResponse = {
  query: string
  sections: ContextBundleSection[]
}

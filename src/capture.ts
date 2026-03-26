import type { EngramConfig } from "./config.ts"
import { contentHash, normalizeForHash } from "./hash.ts"
import type { ChunkInsert } from "./types.ts"

function provisionalType(agent: string): string {
  const a = agent.toLowerCase()
  if (a.includes("planner")) return "analysis"
  if (a.includes("orchestrator")) return "synthesis"
  return "discovery"
}

function shouldSkip(type: string, cfg: EngramConfig): boolean {
  const allow = cfg.capture.allowPartTypes
  if (allow.length > 0 && !allow.includes(type)) return true
  const skip = new Set(cfg.capture.skipPartTypes)
  if (cfg.capture.extraPartTypes.includes(type)) return false
  return skip.has(type)
}

function trunc(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n)
}

function tail(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(-n)
}

export type PartCtx = { agent: string | null; model: string | null }

/** Build rows from a part event. Returns 0 or 1 row for v1. */
export function fromPart(
  part: Record<string, unknown>,
  projectId: string,
  cfg: EngramConfig,
  planSlug: string | null,
  ctx: PartCtx,
): ChunkInsert[] {
  const t = part.type as string
  if (shouldSkip(t, cfg)) return []

  const sessionID = part.sessionID as string
  const messageID = part.messageID as string
  const partID = part.id as string
  const agent = ctx.agent
  const modelFromMeta = ctx.model

  if (t === "text" && cfg.capture.assistantText) {
    const text = part.text as string
    if (!text?.trim()) return []
    const h = contentHash(text)
    return [
      {
        id: "", // filled by runtime ulid
        session_id: sessionID,
        message_id: messageID,
        part_id: partID,
        project_id: projectId,
        role: "assistant",
        agent,
        model: modelFromMeta,
        content_type: provisionalType(agent ?? ""),
        content: trunc(text, cfg.sidecar.maxChunkLength),
        file_paths: null,
        tool_name: null,
        tool_status: null,
        output_head: null,
        output_tail: null,
        output_length: null,
        error_class: null,
        time_created: Date.now(),
        content_hash: h,
        root_session_id: sessionID,
        session_depth: 0,
        plan_slug: planSlug,
      },
    ]
  }

  if (t === "reasoning" && cfg.capture.reasoning) {
    const text = (part as { text: string }).text
    if (!text?.trim()) return []
    const h = contentHash(text)
    return [
      {
        id: "",
        session_id: sessionID,
        message_id: messageID,
        part_id: partID,
        project_id: projectId,
        role: "assistant",
        agent,
        model: modelFromMeta,
        content_type: "reasoning",
        content: trunc(text, cfg.sidecar.maxChunkLength),
        file_paths: null,
        tool_name: null,
        tool_status: null,
        output_head: null,
        output_tail: null,
        output_length: null,
        error_class: null,
        time_created: Date.now(),
        content_hash: h,
        root_session_id: sessionID,
        session_depth: 0,
        plan_slug: planSlug,
      },
    ]
  }

  if (t === "tool" && cfg.capture.toolTraces) {
    const tool = part.tool as string
    const st = part.state as Record<string, unknown>
    const status = st.status as string
    let output = ""
    if (status === "completed") output = (st as { output?: string }).output ?? ""
    if (status === "error") output = (st as { error?: string }).error ?? ""
    const head = cfg.capture.toolOutputHead > 0 ? trunc(output, cfg.capture.toolOutputHead) : ""
    const tailS = cfg.capture.toolOutputTail > 0 ? tail(output, cfg.capture.toolOutputTail) : ""
    const summary = JSON.stringify({ tool, status, args: st.input })
    const body = [summary, head, tailS].filter(Boolean).join("\n")
    const h = contentHash(normalizeForHash(body) + "\n" + tool + "\n" + sessionID)
    return [
      {
        id: "",
        session_id: sessionID,
        message_id: messageID,
        part_id: partID,
        project_id: projectId,
        role: "assistant",
        agent,
        model: modelFromMeta,
        content_type: "tool_trace",
        content: trunc(body, cfg.sidecar.maxChunkLength),
        file_paths: null,
        tool_name: tool,
        tool_status: status,
        output_head: head || null,
        output_tail: tailS || null,
        output_length: output.length,
        error_class: status === "error" ? "tool_error" : null,
        time_created: Date.now(),
        content_hash: h,
        root_session_id: sessionID,
        session_depth: 0,
        plan_slug: planSlug,
      },
    ]
  }

  if (t === "patch" && cfg.capture.toolTraces) {
    const files = (part as { files: string[] }).files
    const hash = (part as { hash: string }).hash
    const body = `patch ${hash} files:${files.join(",")}`
    const h = contentHash(body + sessionID)
    return [
      {
        id: "",
        session_id: sessionID,
        message_id: messageID,
        part_id: partID,
        project_id: projectId,
        role: "assistant",
        agent,
        model: modelFromMeta,
        content_type: "tool_trace",
        content: trunc(body, cfg.sidecar.maxChunkLength),
        file_paths: JSON.stringify(files),
        tool_name: "patch",
        tool_status: "completed",
        output_head: null,
        output_tail: null,
        output_length: body.length,
        error_class: null,
        time_created: Date.now(),
        content_hash: h,
        root_session_id: sessionID,
        session_depth: 0,
        plan_slug: planSlug,
      },
    ]
  }

  return []
}

export function fromAssistantError(
  info: Record<string, unknown>,
  projectId: string,
  cfg: EngramConfig,
  planSlug: string | null,
): ChunkInsert[] {
  const err = info.error as { name?: string; data?: { message?: string } } | undefined
  if (!err) return []
  const sessionID = info.sessionID as string
  const messageID = info.id as string
  const agent = info.agent as string
  const modelID = info.modelID as string
  const msg = err.data?.message ?? err.name ?? "error"
  const body = `error ${err.name}: ${msg}`
  const h = contentHash(body + sessionID)
  return [
    {
      id: "",
      session_id: sessionID,
      message_id: messageID,
      part_id: null,
      project_id: projectId,
      role: "assistant",
      agent,
      model: modelID,
      content_type: "error",
      content: trunc(body, cfg.sidecar.maxChunkLength),
      file_paths: null,
      tool_name: null,
      tool_status: null,
      output_head: null,
      output_tail: null,
      output_length: null,
      error_class: err.name ?? "unknown",
      time_created: Date.now(),
      content_hash: h,
      root_session_id: sessionID,
      session_depth: 0,
      plan_slug: planSlug,
    },
  ]
}

/** Journal / plan mirror from tool output strings (tool.execute.after). */
export function fromMirroredTool(
  tool: string,
  output: string,
  sessionID: string,
  projectId: string,
  cfg: EngramConfig,
  planSlug: string | null,
): ChunkInsert[] {
  if (tool === "journal" && cfg.capture.journalMirror && output) {
    const h = contentHash(output + sessionID + "journal")
    return [
      {
        id: "",
        session_id: sessionID,
        message_id: "mirror",
        part_id: null,
        project_id: projectId,
        role: "assistant",
        agent: null,
        model: null,
        content_type: "decision",
        content: trunc(output, cfg.sidecar.maxChunkLength),
        file_paths: null,
        tool_name: "journal",
        tool_status: "completed",
        output_head: null,
        output_tail: null,
        output_length: output.length,
        error_class: null,
        time_created: Date.now(),
        content_hash: h,
        root_session_id: sessionID,
        session_depth: 0,
        plan_slug: planSlug,
      },
    ]
  }
  if (tool === "plan" && cfg.capture.planMirror && output) {
    const h = contentHash(output + sessionID + "plan")
    return [
      {
        id: "",
        session_id: sessionID,
        message_id: "mirror",
        part_id: null,
        project_id: projectId,
        role: "assistant",
        agent: null,
        model: null,
        content_type: "plan",
        content: trunc(output, cfg.sidecar.maxChunkLength),
        file_paths: null,
        tool_name: "plan",
        tool_status: "completed",
        output_head: null,
        output_tail: null,
        output_length: output.length,
        error_class: null,
        time_created: Date.now(),
        content_hash: h,
        root_session_id: sessionID,
        session_depth: 0,
        plan_slug: planSlug,
      },
    ]
  }
  return []
}

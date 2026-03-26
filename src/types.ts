export type ChunkInsert = {
  id: string
  session_id: string
  message_id: string
  part_id: string | null
  project_id: string
  role: "assistant" | "user"
  agent: string | null
  model: string | null
  content_type: string
  content: string
  file_paths: string | null
  tool_name: string | null
  tool_status: string | null
  output_head: string | null
  output_tail: string | null
  output_length: number | null
  error_class: string | null
  time_created: number
  content_hash: string
  root_session_id: string | null
  session_depth: number | null
  plan_slug: string | null
}

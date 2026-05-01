import path from "node:path"
import { Database } from "bun:sqlite"
import type { EngramConfig } from "./config.ts"

const busyMs = 5000

/** WAL + safety for the Engram sidecar DB (create/migrate). */
export function applySidecarPragmas(db: Database) {
  db.run("PRAGMA journal_mode = WAL;")
  db.run("PRAGMA synchronous = NORMAL;")
  db.run("PRAGMA foreign_keys = ON;")
  db.run(`PRAGMA busy_timeout = ${busyMs};`)
}

/** Shared hot CLI connection: FK checks + brief busy wait under contention. */
export function applyConnPragmas(db: Database) {
  db.run("PRAGMA foreign_keys = ON;")
  db.run(`PRAGMA busy_timeout = ${busyMs};`)
}

export function openMemoryDb(file: string): Database {
  const db = new Database(file, { create: true })
  applySidecarPragmas(db)
  migrate(db)
  return db
}

function migrate(db: Database) {
  const row = db.query("PRAGMA user_version;").get() as { user_version: number } | undefined
  let v = Number(row?.user_version ?? 0)
  if (v < 1) {
    db.exec(`
CREATE TABLE IF NOT EXISTS chunk (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  part_id TEXT,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  agent TEXT,
  model TEXT,
  content_type TEXT NOT NULL,
  content TEXT NOT NULL,
  file_paths TEXT,
  tool_name TEXT,
  tool_status TEXT,
  output_head TEXT,
  output_tail TEXT,
  output_length INTEGER,
  error_class TEXT,
  embedding BLOB,
  time_created INTEGER NOT NULL,
  time_embedded INTEGER,
  content_hash TEXT NOT NULL,
  root_session_id TEXT,
  session_depth INTEGER,
  plan_slug TEXT
);

CREATE INDEX IF NOT EXISTS idx_chunk_session ON chunk(session_id);
CREATE INDEX IF NOT EXISTS idx_chunk_project ON chunk(project_id);
CREATE INDEX IF NOT EXISTS idx_chunk_type ON chunk(content_type);
CREATE INDEX IF NOT EXISTS idx_chunk_agent ON chunk(agent);
CREATE INDEX IF NOT EXISTS idx_chunk_time ON chunk(time_created);
CREATE INDEX IF NOT EXISTS idx_chunk_tool ON chunk(tool_name) WHERE tool_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunk_unembedded ON chunk(id) WHERE time_embedded IS NULL;
CREATE INDEX IF NOT EXISTS idx_chunk_hash ON chunk(content_hash);
CREATE INDEX IF NOT EXISTS idx_chunk_plan ON chunk(plan_slug) WHERE plan_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunk_root ON chunk(root_session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  chunk_id UNINDEXED,
  content,
  file_paths,
  tool_name,
  agent,
  content_type,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunk_ai AFTER INSERT ON chunk BEGIN
  INSERT INTO chunk_fts(chunk_id, content, file_paths, tool_name, agent, content_type)
  VALUES (
    new.id,
    new.content,
    coalesce(new.file_paths, ''),
    coalesce(new.tool_name, ''),
    coalesce(new.agent, ''),
    new.content_type
  );
END;

CREATE TRIGGER IF NOT EXISTS chunk_ad AFTER DELETE ON chunk BEGIN
  DELETE FROM chunk_fts WHERE chunk_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS chunk_au AFTER UPDATE ON chunk BEGIN
  DELETE FROM chunk_fts WHERE chunk_id = old.id;
  INSERT INTO chunk_fts(chunk_id, content, file_paths, tool_name, agent, content_type)
  VALUES (
    new.id,
    new.content,
    coalesce(new.file_paths, ''),
    coalesce(new.tool_name, ''),
    coalesce(new.agent, ''),
    new.content_type
  );
END;

CREATE TABLE IF NOT EXISTS archive (
  id TEXT PRIMARY KEY,
  root_session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  session_count INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  archive_path TEXT NOT NULL,
  archive_size INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_archive_project ON archive(project_id);

CREATE TABLE IF NOT EXISTS type_proposal (
  id TEXT PRIMARY KEY,
  proposed_type TEXT NOT NULL,
  chunk_id TEXT NOT NULL REFERENCES chunk(id),
  confidence REAL,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_type_proposal ON type_proposal(proposed_type);

CREATE TABLE IF NOT EXISTS retrieval_log (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  query TEXT NOT NULL,
  returned_ids TEXT NOT NULL,
  referenced_ids TEXT,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_session ON retrieval_log(session_id);

CREATE TABLE IF NOT EXISTS friction_cache (
  id TEXT PRIMARY KEY,
  report TEXT NOT NULL,
  chunk_window TEXT NOT NULL,
  time_created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS export_checkpoint (
  root_session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  exported_message_id TEXT,
  exported_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER,
  phase TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_memory_last (
  session_id TEXT PRIMARY KEY,
  log_id TEXT NOT NULL,
  chunk_ids TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

PRAGMA user_version = 1;
  `)
    v = 1
  }

  if (v < 2) {
    db.exec(`
ALTER TABLE export_checkpoint ADD COLUMN exported_part_id TEXT;
PRAGMA user_version = 2;
    `)
    v = 2
  }

  if (v < 3) {
    db.exec(`
CREATE TABLE IF NOT EXISTS engram_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
PRAGMA user_version = 3;
    `)
    v = 3
  }

  if (v < 4) {
    db.exec(`
DROP TRIGGER IF EXISTS chunk_au;

CREATE TRIGGER IF NOT EXISTS chunk_au AFTER UPDATE OF content, file_paths, tool_name, agent, content_type ON chunk BEGIN
  DELETE FROM chunk_fts WHERE chunk_id = old.id;
  INSERT INTO chunk_fts(chunk_id, content, file_paths, tool_name, agent, content_type)
  VALUES (
    new.id,
    new.content,
    coalesce(new.file_paths, ''),
    coalesce(new.tool_name, ''),
    coalesce(new.agent, ''),
    new.content_type
  );
END;

CREATE INDEX IF NOT EXISTS idx_chunk_project_hash ON chunk(project_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_chunk_unembedded_project_time ON chunk(project_id, time_created) WHERE time_embedded IS NULL;
CREATE INDEX IF NOT EXISTS idx_chunk_identity_hash ON chunk(project_id, session_id, message_id, coalesce(part_id, ''), content_hash);

PRAGMA user_version = 4;
    `)
    v = 4
  }

  if (v < 5) {
    db.exec(`
ALTER TABLE chunk ADD COLUMN embedding_model TEXT;
ALTER TABLE chunk ADD COLUMN embedding_dimensions INTEGER;

UPDATE chunk SET time_embedded = NULL
WHERE embedding IS NOT NULL AND (embedding_model IS NULL OR embedding_dimensions IS NULL);

CREATE INDEX IF NOT EXISTS idx_chunk_embedding_version
  ON chunk(project_id, embedding_model, embedding_dimensions)
  WHERE embedding IS NOT NULL;

PRAGMA user_version = 5;
    `)
    v = 5
  }

  if (v < 6) {
    db.exec(`
CREATE TABLE export_checkpoint_next (
  root_session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  exported_message_id TEXT,
  exported_part_id TEXT,
  exported_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER,
  phase TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, root_session_id)
);

INSERT OR REPLACE INTO export_checkpoint_next (
  root_session_id, project_id, exported_message_id, exported_part_id, exported_count, total_count, phase, updated_at
)
SELECT root_session_id, project_id, exported_message_id, exported_part_id, exported_count, total_count, phase, updated_at
FROM export_checkpoint;

DROP TABLE export_checkpoint;
ALTER TABLE export_checkpoint_next RENAME TO export_checkpoint;
CREATE INDEX IF NOT EXISTS idx_export_checkpoint_project ON export_checkpoint(project_id);

PRAGMA user_version = 6;
    `)
    v = 6
  }

  if (v < 7) {
    db.exec(`
CREATE TABLE IF NOT EXISTS operation_metric (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  rows_count INTEGER,
  bytes_count INTEGER,
  heap_used_delta INTEGER,
  rss_delta INTEGER,
  detail TEXT,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operation_metric_project_time ON operation_metric(project_id, time_created DESC);
CREATE INDEX IF NOT EXISTS idx_operation_metric_project_op_time ON operation_metric(project_id, operation, time_created DESC);

PRAGMA user_version = 7;
    `)
    v = 7
  }

  if (v < 8) {
    db.exec(`
CREATE TABLE IF NOT EXISTS eval_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  fixture_name TEXT NOT NULL,
  fixture_hash TEXT NOT NULL,
  report_json TEXT NOT NULL,
  recall_at_k REAL NOT NULL,
  mrr REAL NOT NULL,
  p50_ms REAL NOT NULL,
  p95_ms REAL NOT NULL,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_run_project_time ON eval_run(project_id, time_created DESC);

PRAGMA user_version = 8;
    `)
    v = 8
  }

  if (v < 9) {
    db.exec(`
CREATE TABLE IF NOT EXISTS retrieval_feedback (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  session_id TEXT,
  rating TEXT NOT NULL,
  note TEXT,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_project_chunk ON retrieval_feedback(project_id, chunk_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_project_time ON retrieval_feedback(project_id, time_created DESC);

PRAGMA user_version = 9;
    `)
    v = 9
  }

  if (v < 10) {
    db.exec(`
CREATE TABLE IF NOT EXISTS curation_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  applied INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  time_created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS curation_proposal (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES curation_run(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  action TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  duplicate_of TEXT,
  score REAL,
  applied INTEGER NOT NULL DEFAULT 0,
  time_created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_curation_run_project_time ON curation_run(project_id, time_created DESC);
CREATE INDEX IF NOT EXISTS idx_curation_proposal_project_action ON curation_proposal(project_id, action);

PRAGMA user_version = 10;
    `)
    v = 10
  }

  if (v < 11) {
    db.exec(`
ALTER TABLE chunk ADD COLUMN source_kind TEXT;
ALTER TABLE chunk ADD COLUMN source_ref TEXT;
ALTER TABLE chunk ADD COLUMN authority REAL NOT NULL DEFAULT 0;
ALTER TABLE chunk ADD COLUMN superseded_by TEXT;

CREATE INDEX IF NOT EXISTS idx_chunk_project_source_ref ON chunk(project_id, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chunk_project_authority ON chunk(project_id, authority DESC);
CREATE INDEX IF NOT EXISTS idx_chunk_project_superseded ON chunk(project_id, superseded_by) WHERE superseded_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS artifact_source (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mtime_ms INTEGER,
  size_bytes INTEGER,
  last_ingested_at INTEGER NOT NULL,
  UNIQUE(project_id, path)
);

CREATE TABLE IF NOT EXISTS artifact_item (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES artifact_source(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  slug TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  authority REAL NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  UNIQUE(project_id, source_id, content_hash)
);

CREATE TABLE IF NOT EXISTS artifact_ingest_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  dry_run INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  time_created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_root_index (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  title TEXT,
  time_created INTEGER,
  time_updated INTEGER,
  child_count INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  part_count INTEGER NOT NULL,
  assistant_count INTEGER NOT NULL,
  user_count INTEGER NOT NULL,
  tool_count INTEGER NOT NULL,
  patch_count INTEGER NOT NULL,
  reasoning_count INTEGER NOT NULL,
  primary_agents_json TEXT NOT NULL,
  priority_score REAL NOT NULL,
  status TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at INTEGER NOT NULL,
  UNIQUE(project_id, root_session_id)
);

CREATE TABLE IF NOT EXISTS session_distillation (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  root_session_id TEXT NOT NULL,
  model TEXT,
  summary_json TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  UNIQUE(project_id, root_session_id, source_hash)
);

CREATE TABLE IF NOT EXISTS memory_relation (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  from_chunk_id TEXT NOT NULL,
  to_chunk_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  UNIQUE(project_id, from_chunk_id, to_chunk_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_artifact_source_project_kind ON artifact_source(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_artifact_item_project_kind ON artifact_item(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_artifact_ingest_project_time ON artifact_ingest_run(project_id, time_created DESC);
CREATE INDEX IF NOT EXISTS idx_session_root_project_score ON session_root_index(project_id, priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_distillation_project_root ON session_distillation(project_id, root_session_id);
CREATE INDEX IF NOT EXISTS idx_memory_relation_project_from ON memory_relation(project_id, from_chunk_id);
CREATE INDEX IF NOT EXISTS idx_memory_relation_project_to ON memory_relation(project_id, to_chunk_id);

PRAGMA user_version = 11;
    `)
    v = 11
  }
}

export function sidecarPath(worktree: string, cfg: EngramConfig): string {
  const p = cfg.sidecar.path
  if (path.isAbsolute(p)) return p
  return path.join(worktree, p)
}

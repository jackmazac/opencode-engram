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
  }
}

export function sidecarPath(worktree: string, cfg: EngramConfig): string {
  const p = cfg.sidecar.path
  if (path.isAbsolute(p)) return p
  return path.join(worktree, p)
}

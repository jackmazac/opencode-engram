#!/usr/bin/env bun
import path from "node:path"
import os from "node:os"
import readline from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import {
  deleteSubtreeFromHot,
  exportRootSession,
  listArchiveRows,
  staleRootIds,
  verifyArchiveFile,
} from "../archive.ts"
import { loadConfig, expandArchivePath } from "../config.ts"
import { applyConnPragmas, openMemoryDb, sidecarPath } from "../db.ts"
import { defaultHotDbPath } from "../paths.ts"

function worktreeFromArgs(args: string[]): string {
  const i = args.indexOf("--worktree")
  const w = i >= 0 ? args[i + 1] : undefined
  if (w) return path.resolve(w)
  return process.cwd()
}

function projectIdFromArgs(args: string[]): string | undefined {
  const i = args.indexOf("--project-id")
  if (i >= 0 && args[i + 1]) return args[i + 1]
  return process.env.ENGRAM_PROJECT_ID
}

function hotPath(cfg: ReturnType<typeof loadConfig>): string {
  return cfg.archive.hotDbPath ?? defaultHotDbPath()
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output })
  const a = (await rl.question(question)).trim().toLowerCase()
  rl.close()
  return a === "y" || a === "yes"
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv[0] !== "archive" || argv.length < 2) {
    console.error(`Usage:
  engram archive list [--worktree DIR]
  engram archive export [--force] <rootSessionId> [--worktree DIR]
  engram archive verify <rootSessionId> [--worktree DIR]
  engram archive delete [--vacuum] <rootSessionId> [<rootSessionId>...] [--worktree DIR]
  engram archive export-stale [--worktree DIR]   # export one stale root (non-destructive)`)
    process.exit(1)
  }

  const wt = worktreeFromArgs(argv)
  const cfg = loadConfig(wt)
  const memoryPath = sidecarPath(wt, cfg)
  const memoryDb = openMemoryDb(memoryPath)
  const hot = hotPath(cfg)
  const home = os.homedir()

  const rest = argv.filter(
    (x, i) =>
      !(
        argv[i - 1] === "--worktree" ||
        x === "--worktree" ||
        argv[i - 1] === "--project-id" ||
        x === "--project-id"
      ),
  )

  if (rest[1] === "list") {
    const pid = projectIdFromArgs(argv)
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID (see project table in opencode.db).")
      process.exit(1)
    }
    const rows = listArchiveRows(memoryDb, pid)
    const archRoot = expandArchivePath(home, cfg.archive)
    console.log(`Archive dir: ${archRoot}`)
    console.log(`Hot db: ${hot}`)
    for (const r of rows) {
      console.log(
        `${r.root_session_id}\tmsgs=${r.message_count}\tparts=${r.part_count}\t${r.archive_path}\t${r.content_hash.slice(0, 12)}…`,
      )
    }
    const stale = staleRootIds(hot, pid, cfg.archive.staleDays, Date.now())
    if (stale.length) console.log(`\nStale roots (${cfg.archive.staleDays}d): ${stale.join(", ")}`)
    memoryDb.close()
    return
  }

  if (rest[1] === "export-stale") {
    const pid = projectIdFromArgs(argv)
    if (!pid) {
      console.error("Pass --project-id or set ENGRAM_PROJECT_ID.")
      process.exit(1)
    }
    const stale = staleRootIds(hot, pid, cfg.archive.staleDays, Date.now())
    const root = stale[0]
    if (!root) {
      console.log("No stale roots.")
      memoryDb.close()
      return
    }
    await exportRootSession({
      memoryDb,
      hotPath: hot,
      projectId: pid,
      rootSessionId: root,
      cfg,
      home,
      force: false,
      onProgress: (m) => console.log(m),
    })
    memoryDb.close()
    return
  }

  if (rest[1] === "export") {
    const force = rest.includes("--force")
    const ids = rest.slice(2).filter((x) => x !== "--force")
    const root = ids[0]
    const pid = projectIdFromArgs(argv)
    if (!root || !pid) {
      console.error("Usage: engram archive export [--force] <rootSessionId>  (requires ENGRAM_PROJECT_ID)")
      process.exit(1)
    }
    await exportRootSession({
      memoryDb,
      hotPath: hot,
      projectId: pid,
      rootSessionId: root,
      cfg,
      home,
      force,
      onProgress: (m) => console.log(m),
    })
    memoryDb.close()
    return
  }

  if (rest[1] === "verify") {
    const root = rest[2]
    const pid = projectIdFromArgs(argv)
    if (!root || !pid) {
      console.error("Usage: engram archive verify <rootSessionId>")
      process.exit(1)
    }
    const r = verifyArchiveFile({
      memoryDb,
      archiveRoot: expandArchivePath(home, cfg.archive),
      projectId: pid,
      rootSessionId: root,
    })
    console.log(r.ok ? r.detail : `FAIL: ${r.detail}`)
    memoryDb.close()
    process.exit(r.ok ? 0 : 1)
  }

  if (rest[1] === "delete") {
    const vacuum = rest.includes("--vacuum")
    const ids = rest.slice(2).filter((x) => x !== "--vacuum")
    const pid = projectIdFromArgs(argv)
    if (!ids.length || !pid) {
      console.error("Usage: engram archive delete [--vacuum] <rootSessionId> ...")
      process.exit(1)
    }
    for (const root of ids) {
      const v = verifyArchiveFile({
        memoryDb,
        archiveRoot: expandArchivePath(home, cfg.archive),
        projectId: pid,
        rootSessionId: root,
      })
      if (!v.ok) {
        console.error(`Refusing ${root}: archive not verified (${v.detail})`)
        process.exit(1)
      }
    }
    if (!(await confirm(`Delete ${ids.length} session tree(s) from ${hot}? Type yes: `))) {
      console.log("Aborted.")
      memoryDb.close()
      return
    }
    for (const root of ids) {
      deleteSubtreeFromHot({ hotPath: hot, projectId: pid, rootSessionId: root, vacuum: false })
      console.log(`Deleted tree ${root}`)
    }
    if (vacuum) {
      const { Database } = await import("bun:sqlite")
      const d = new Database(hot)
      applyConnPragmas(d)
      d.run("VACUUM")
      d.close()
      console.log("VACUUM complete.")
    }
    memoryDb.close()
    return
  }

  console.error(`Unknown subcommand: ${rest[1]}`)
  process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

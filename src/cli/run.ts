#!/usr/bin/env bun
import path from "node:path"
import os from "node:os"
import readline from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import {
  deleteSubtreeFromHot,
  exportRootSession,
  importArchiveToMemory,
  inspectArchive,
  listArchiveRows,
  restoreArchiveToHot,
  searchArchive,
  staleRootIds,
  verifyArchiveFile,
} from "../archive.ts"
import { formatArtifactIngestSummary, ingestArtifacts } from "../artifacts.ts"
import { buildContextBundle, formatContextBundle } from "../context.ts"
import { loadConfig, expandArchivePath } from "../config.ts"
import { formatCurationSummary, runCuration } from "../curation.ts"
import { buildDashboardReport, formatDashboardReport } from "../dashboard.ts"
import { applyConnPragmas, openMemoryDb, sidecarPath } from "../db.ts"
import { distillRoots, formatDistillSummary } from "../distill.ts"
import { formatEvalReport, runEval } from "../eval.ts"
import { backfillHot, formatHotBackfillSummary, type BackfillStrategy } from "../hot-backfill.ts"
import { runMaintenance } from "../maintenance.ts"
import { runManualSprint } from "../manual-sprint.ts"
import { defaultHotDbPath } from "../paths.ts"
import { buildMemoryRelations, formatRelationSummary } from "../relations.ts"
import { formatRootIndexSummary, indexHotRoots } from "../root-index.ts"
import { formatTelemetryReport, pruneMetrics, recentMetrics } from "../telemetry.ts"

const repoRoot = path.resolve(import.meta.dir, "..", "..")

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

function numberArg(args: string[], name: string, fallback: number): number {
  const i = args.indexOf(name)
  const raw = i >= 0 ? args[i + 1] : undefined
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function valueArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output })
  const a = (await rl.question(question)).trim().toLowerCase()
  rl.close()
  return a === "y" || a === "yes"
}

async function main() {
  const argv = process.argv.slice(2)
  if (
    ![
      "archive",
      "backfill-hot",
      "context",
      "curate",
      "dashboard",
      "distill",
      "eval",
      "index-hot",
      "ingest-artifacts",
      "maintain",
      "relations",
      "telemetry",
      "sprint",
    ].includes(argv[0] ?? "")
  ) {
    console.error(`Usage:
  engram archive list [--worktree DIR]
  engram archive export [--force] <rootSessionId> [--worktree DIR]
  engram archive verify <rootSessionId> [--worktree DIR]
  engram archive verify-all [--worktree DIR]
  engram archive inspect <rootSessionId> [--worktree DIR]
  engram archive restore [--apply] <rootSessionId> [--worktree DIR]
  engram archive search <rootSessionId> <query> [--limit N] [--worktree DIR]
  engram archive import-memory <rootSessionId> [--worktree DIR]
  engram archive delete [--vacuum] <rootSessionId> [<rootSessionId>...] [--worktree DIR]
  engram archive export-stale [--all] [--worktree DIR]   # export stale roots (non-destructive)
  engram ingest-artifacts [--apply] [--kind journal,plan] [--max N] [--project-id ID] [--worktree DIR]
  engram index-hot [--apply] [--max N] [--project-id ID] [--worktree DIR]
  engram backfill-hot [--apply] [--strategy priority|artifact-linked|recent|errors|patches] [--max-roots N] [--max-parts N] [--project-id ID] [--worktree DIR]
  engram distill [--apply] [--top N] [--project-id ID] [--worktree DIR]
  engram relations [--apply] [--max N] [--project-id ID] [--worktree DIR]
  engram context <query> [--limit N] [--project-id ID] [--worktree DIR]
  engram eval run --fixture FILE [--out DIR] [--live] [--rerank] [--worktree DIR]
  engram eval query --fixture FILE --query-id ID [--live] [--rerank] [--worktree DIR]
  engram curate [--apply] [--max N] [--project-id ID] [--worktree DIR]
  engram dashboard [--json] [--project-id ID] [--worktree DIR]
  engram maintain [--apply] [--prune-telemetry] [--verify-archives] [--export-stale] [--compact-db] [--health-report] [--project-id ID] [--worktree DIR]
  engram telemetry [--limit N] [--project-id ID] [--worktree DIR]
  engram sprint [--rows N] [--local-only] [--rerank] [--worktree DIR]`)
    process.exit(1)
  }

  const wt = worktreeFromArgs(argv)
  const cfg = loadConfig(wt)

  if (argv[0] === "sprint") {
    const rows = numberArg(argv, "--rows", 3000)
    console.log(
      await runManualSprint({
        cfg,
        rows,
        live: !argv.includes("--local-only"),
        rerank: argv.includes("--rerank"),
      }),
    )
    return
  }

  const memoryPath = sidecarPath(wt, cfg)
  const memoryDb = openMemoryDb(memoryPath)
  const hot = hotPath(cfg)
  const home = os.homedir()

  if (argv[0] === "ingest-artifacts") {
    const pid = projectIdFromArgs(argv)
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.")
      process.exit(1)
    }
    const kinds = valueArg(argv, "--kind")
      ?.split(",")
      .map((x) => x.trim())
      .filter(Boolean)
    const summary = ingestArtifacts({
      db: memoryDb,
      worktree: wt,
      projectId: pid,
      cfg,
      dryRun: !argv.includes("--apply"),
      kinds,
      max: numberArg(argv, "--max", Number.POSITIVE_INFINITY),
    })
    console.log(formatArtifactIngestSummary(summary))
    memoryDb.close()
    return
  }

  if (argv[0] === "index-hot") {
    const pid = projectIdFromArgs(argv)
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.")
      process.exit(1)
    }
    const summary = indexHotRoots({
      db: memoryDb,
      hotPath: hot,
      projectId: pid,
      max: numberArg(argv, "--max", Number.POSITIVE_INFINITY),
      dryRun: !argv.includes("--apply"),
    })
    console.log(formatRootIndexSummary(summary))
    memoryDb.close()
    return
  }

  if (argv[0] === "backfill-hot") {
    const pid = projectIdFromArgs(argv)
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.")
      process.exit(1)
    }
    const strategy = (valueArg(argv, "--strategy") ?? "priority") as BackfillStrategy
    const summary = backfillHot({
      db: memoryDb,
      hotPath: hot,
      projectId: pid,
      cfg,
      strategy,
      dryRun: !argv.includes("--apply"),
      maxRoots: numberArg(argv, "--max-roots", 10),
      maxParts: numberArg(argv, "--max-parts", 500),
    })
    console.log(formatHotBackfillSummary(summary))
    memoryDb.close()
    return
  }

  if (argv[0] === "distill") {
    const pid = projectIdFromArgs(argv)
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.")
      process.exit(1)
    }
    console.log(
      formatDistillSummary(
        distillRoots({
          db: memoryDb,
          projectId: pid,
          cfg,
          top: numberArg(argv, "--top", 20),
          dryRun: !argv.includes("--apply"),
        }),
      ),
    )
    memoryDb.close()
    return
  }

  if (argv[0] === "relations") {
    const pid = projectIdFromArgs(argv)
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.")
      process.exit(1)
    }
    console.log(
      formatRelationSummary(
        buildMemoryRelations({
          db: memoryDb,
          projectId: pid,
          dryRun: !argv.includes("--apply"),
          max: numberArg(argv, "--max", 100),
        }),
      ),
    )
    memoryDb.close()
    return
  }

  if (argv[0] === "context") {
    const pid = projectIdFromArgs(argv)
    const query = argv.filter(
      (x, i) => !x.startsWith("--") && argv[i - 1] !== "--project-id" && argv[i - 1] !== "--worktree",
    )[1]
    if (!pid || !query) {
      console.error("Usage: engram context <query> --project-id <uuid>")
      process.exit(1)
    }
    console.log(
      formatContextBundle(
        buildContextBundle({
          db: memoryDb,
          projectId: pid,
          query,
          limit: numberArg(argv, "--limit", 12),
        }),
      ),
    )
    memoryDb.close()
    return
  }

  if (argv[0] === "telemetry") {
    const pid = projectIdFromArgs(argv)
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.")
      process.exit(1)
    }
    pruneMetrics(memoryDb, pid, cfg.telemetry.retainDays)
    console.log(formatTelemetryReport(recentMetrics(memoryDb, pid, numberArg(argv, "--limit", 200)), "CLI"))
    memoryDb.close()
    return
  }

  if (argv[0] === "eval") {
    const fixture = valueArg(argv, "--fixture") ?? path.join(repoRoot, "eval", "fixtures", "core.json")
    const outDir = valueArg(argv, "--out")
    const queryId = valueArg(argv, "--query-id")
    if (argv[1] === "query" && !queryId) {
      console.error("Usage: engram eval query --fixture FILE --query-id ID")
      process.exit(1)
    }
    const report = await runEval({
      fixturePath: path.resolve(fixture),
      cfg,
      outDir: outDir ? path.resolve(outDir) : undefined,
      memoryDb,
      queryId: argv[1] === "query" ? queryId : undefined,
      live: argv.includes("--live"),
      rerank: argv.includes("--rerank"),
    })
    console.log(formatEvalReport(report))
    memoryDb.close()
    return
  }

  if (argv[0] === "dashboard") {
    const pid = projectIdFromArgs(argv)
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.")
      process.exit(1)
    }
    const report = buildDashboardReport({ db: memoryDb, projectId: pid, cfg, worktree: wt })
    console.log(argv.includes("--json") ? JSON.stringify(report, null, 2) : formatDashboardReport(report))
    memoryDb.close()
    return
  }

  if (argv[0] === "maintain") {
    const pid = projectIdFromArgs(argv)
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.")
      process.exit(1)
    }
    console.log(
      await runMaintenance({
        memoryDb,
        hotPath: hot,
        projectId: pid,
        cfg,
        home,
        dryRun: !argv.includes("--apply"),
        pruneTelemetry: argv.includes("--prune-telemetry"),
        verifyArchives: argv.includes("--verify-archives"),
        exportStale: argv.includes("--export-stale"),
        compactDb: argv.includes("--compact-db"),
        healthReport:
          argv.includes("--health-report") ||
          !(
            argv.includes("--prune-telemetry") ||
            argv.includes("--verify-archives") ||
            argv.includes("--export-stale") ||
            argv.includes("--compact-db")
          ),
      }),
    )
    memoryDb.close()
    return
  }

  if (argv[0] === "curate") {
    const pid = projectIdFromArgs(argv)
    if (!pid) {
      console.error("Pass --project-id <uuid> or set ENGRAM_PROJECT_ID.")
      process.exit(1)
    }
    const summary = runCuration({
      db: memoryDb,
      projectId: pid,
      apply: argv.includes("--apply"),
      max: numberArg(argv, "--max", 100),
    })
    console.log(formatCurationSummary(summary))
    memoryDb.close()
    return
  }

  const rest = argv.filter(
    (x, i) =>
      !(argv[i - 1] === "--worktree" || x === "--worktree" || argv[i - 1] === "--project-id" || x === "--project-id"),
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
    const roots = rest.includes("--all") ? stale : stale.slice(0, 1)
    if (roots.length === 0) {
      console.log("No stale roots.")
      memoryDb.close()
      return
    }
    for (const root of roots) {
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
    }
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
    const r = await verifyArchiveFile({
      memoryDb,
      archiveRoot: expandArchivePath(home, cfg.archive),
      projectId: pid,
      rootSessionId: root,
    })
    console.log(r.ok ? r.detail : `FAIL: ${r.detail}`)
    memoryDb.close()
    process.exit(r.ok ? 0 : 1)
  }

  if (rest[1] === "verify-all") {
    const pid = projectIdFromArgs(argv)
    if (!pid) {
      console.error("Usage: engram archive verify-all (requires ENGRAM_PROJECT_ID)")
      process.exit(1)
    }
    const rows = listArchiveRows(memoryDb, pid)
    const archiveRoot = expandArchivePath(home, cfg.archive)
    let ok = true
    for (const row of rows) {
      const r = await verifyArchiveFile({
        memoryDb,
        archiveRoot,
        projectId: pid,
        rootSessionId: row.root_session_id,
      })
      console.log(`${r.ok ? "OK" : "FAIL"}\t${row.root_session_id}\t${r.detail}`)
      if (!r.ok) ok = false
    }
    if (rows.length === 0) console.log("No archive rows.")
    memoryDb.close()
    process.exit(ok ? 0 : 1)
  }

  if (rest[1] === "inspect") {
    const root = rest[2]
    const pid = projectIdFromArgs(argv)
    if (!root || !pid) {
      console.error("Usage: engram archive inspect <rootSessionId>")
      process.exit(1)
    }
    const counts = await inspectArchive({
      memoryDb,
      archiveRoot: expandArchivePath(home, cfg.archive),
      projectId: pid,
      rootSessionId: root,
    })
    console.log(`sessions=${counts.sessions}\tmessages=${counts.messages}\tparts=${counts.parts}`)
    memoryDb.close()
    return
  }

  if (rest[1] === "restore") {
    const root = rest.slice(2).find((x) => x !== "--dry-run" && x !== "--apply")
    const pid = projectIdFromArgs(argv)
    if (!root || !pid) {
      console.error("Usage: engram archive restore [--apply] <rootSessionId>")
      process.exit(1)
    }
    const dryRun = !rest.includes("--apply")
    const result = await restoreArchiveToHot({
      memoryDb,
      archiveRoot: expandArchivePath(home, cfg.archive),
      hotPath: hot,
      projectId: pid,
      rootSessionId: root,
      dryRun,
    })
    console.log(
      `${dryRun ? "Would restore" : "Restored"} sessions=${result.sessions} messages=${result.messages} parts=${result.parts}`,
    )
    memoryDb.close()
    return
  }

  if (rest[1] === "search") {
    const root = rest[2]
    const query = rest[3]
    const pid = projectIdFromArgs(argv)
    if (!root || !query || !pid) {
      console.error("Usage: engram archive search <rootSessionId> <query>")
      process.exit(1)
    }
    const rows = await searchArchive({
      memoryDb,
      archiveRoot: expandArchivePath(home, cfg.archive),
      projectId: pid,
      rootSessionId: root,
      query,
      limit: numberArg(argv, "--limit", 20),
    })
    console.log(rows.length ? rows.join("\n") : "No archive matches.")
    memoryDb.close()
    return
  }

  if (rest[1] === "import-memory") {
    const root = rest[2]
    const pid = projectIdFromArgs(argv)
    if (!root || !pid) {
      console.error("Usage: engram archive import-memory <rootSessionId>")
      process.exit(1)
    }
    const result = await importArchiveToMemory({
      memoryDb,
      archiveRoot: expandArchivePath(home, cfg.archive),
      projectId: pid,
      rootSessionId: root,
      cfg,
    })
    console.log(`Imported ${result.inserted} chunks from ${result.scannedParts} archived parts.`)
    memoryDb.close()
    return
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
      const v = await verifyArchiveFile({
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
      deleteSubtreeFromHot({
        hotPath: hot,
        projectId: pid,
        rootSessionId: root,
        vacuum: false,
      })
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

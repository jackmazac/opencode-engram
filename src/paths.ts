import path from "node:path"
import os from "node:os"
import { xdgData } from "xdg-basedir"

/** Matches opencode Global.Path.data: xdg data + "opencode" */
export function opencodeDataDir(): string {
  if (process.env.OPENCODE_TEST_HOME) return path.join(process.env.OPENCODE_TEST_HOME, ".local", "share", "opencode")
  const base = xdgData ?? path.join(os.homedir(), ".local", "share")
  return path.join(base, "opencode")
}

export function defaultHotDbPath(): string {
  if (process.env.OPENCODE_DB) {
    const d = process.env.OPENCODE_DB
    if (path.isAbsolute(d)) return d
    return path.join(opencodeDataDir(), d)
  }
  return path.join(opencodeDataDir(), "opencode.db")
}

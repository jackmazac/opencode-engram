import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import EngramPlugin from "../src/index.ts"

describe("EngramPlugin", () => {
  test("exports hook keys only", async () => {
    const wt = mkdtempSync(path.join(os.tmpdir(), "engram-pc-"))
    const hooks = await EngramPlugin({
      client: {} as never,
      project: { id: "p" } as never,
      directory: wt,
      worktree: wt,
      serverUrl: new URL("http://localhost"),
      $: {} as never,
    })
    const k = Object.keys(hooks)
    expect(k.every((x) => ["event", "tool.execute.after", "experimental.chat.system.transform", "tool"].includes(x))).toBe(
      true,
    )
    expect(typeof hooks.tool?.memory?.execute).toBe("function")
  })
})

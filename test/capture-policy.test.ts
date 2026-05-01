import { describe, expect, test } from "bun:test"
import { defaultEngramConfig } from "../src/config.ts"
import { fromPart } from "../src/capture.ts"

const ctx = { agent: "executor", model: "model" }

describe("capture policy", () => {
  test("skips completed denied tool output by default", () => {
    const rows = fromPart(
      {
        id: "p1",
        sessionID: "s1",
        messageID: "m1",
        type: "tool",
        tool: "read",
        state: { status: "completed", output: "large file body" },
      },
      "project",
      defaultEngramConfig,
      null,
      ctx,
    )
    expect(rows).toHaveLength(0)
  })

  test("captures bounded error output even for denied tools", () => {
    const rows = fromPart(
      {
        id: "p2",
        sessionID: "s1",
        messageID: "m1",
        type: "tool",
        tool: "read",
        state: { status: "error", error: "x".repeat(20_000) },
      },
      "project",
      defaultEngramConfig,
      null,
      ctx,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.output_length).toBe(10_000)
    expect(rows[0]?.error_class).toBe("tool_error")
  })
})

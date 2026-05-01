import { describe, expect, test } from "bun:test"
import { ORCHESTRATOR_HINT_BLOCK, appendOrchestratorHint, systemLooksInternal } from "../src/orchestrator-hint.ts"

describe("orchestrator hint", () => {
  test("systemLooksInternal", () => {
    expect(systemLooksInternal("You are a title generator for chats")).toBe(true)
    expect(systemLooksInternal("Primary agent that plans and delegates")).toBe(false)
  })

  test("appendOrchestratorHint mutates last chunk", () => {
    const system = ["header"]
    appendOrchestratorHint(system, ORCHESTRATOR_HINT_BLOCK)
    expect(system[0]?.includes("<engram-hint>")).toBe(true)
    appendOrchestratorHint(system, ORCHESTRATOR_HINT_BLOCK)
    expect(system.filter((s) => s.includes("<engram-hint>")).length).toBe(1)
  })
})

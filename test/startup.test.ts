import { describe, expect, test } from "bun:test"
import { defaultEngramConfig } from "../src/config.ts"

describe("startup defaults", () => {
  test("hot DB backfill is opt-in so plugin init does not scan large OpenCode databases", () => {
    expect(defaultEngramConfig.backfill.enabled).toBe(true)
    expect(defaultEngramConfig.backfill.auto).toBe(false)
    expect(defaultEngramConfig.backfill.startupDelayMs).toBeGreaterThanOrEqual(30_000)
  })
})

import { describe, expect, test } from "bun:test"
import { defaultEngramConfig } from "../src/config.ts"

describe("startup defaults", () => {
  test("hot DB backfill is delayed so plugin init does not scan large OpenCode databases", () => {
    expect(defaultEngramConfig.backfill.enabled).toBe(true)
    expect(defaultEngramConfig.backfill.auto).toBe(true)
    expect(defaultEngramConfig.backfill.repeat).toBe(false)
    expect(defaultEngramConfig.backfill.startupDelayMs).toBeGreaterThanOrEqual(60_000)
  })
})

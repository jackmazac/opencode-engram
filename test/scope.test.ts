import { describe, expect, test } from "bun:test"
import { defaultEngramConfig } from "../src/config.ts"
import { scopeClause } from "../src/retrieve.ts"

const cfg = defaultEngramConfig

describe("scopeClause", () => {
  test("recent applies cutoff", () => {
    const { sql, args } = scopeClause("recent", cfg, "p1")
    expect(sql).toContain("time_created >=")
    expect(args.length).toBe(3)
  })

  test("decisions includes grace", () => {
    const { sql, args } = scopeClause("decisions", cfg, "p1")
    expect(sql).toContain("content_type IN")
    expect(sql).toContain("time_embedded")
    expect(args.length).toBeGreaterThan(1)
  })
})

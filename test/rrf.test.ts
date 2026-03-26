import { describe, expect, test } from "bun:test"
import { rrfMerge } from "../src/rrf.ts"

describe("rrfMerge", () => {
  test("stable merge and tie-break", () => {
    const a = rrfMerge([
      ["x", "y"],
      ["y", "z"],
    ])
    expect(a[0]?.id).toBe("y")
    expect(a.map((r) => r.id)).toEqual(["y", "x", "z"])
  })
})

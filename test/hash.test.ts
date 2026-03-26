import { describe, expect, test } from "bun:test"
import { contentHash, normalizeForHash } from "../src/hash.ts"

describe("hash", () => {
  test("whitespace normalization", () => {
    expect(normalizeForHash("a  \n b")).toBe("a b")
  })

  test("same hash after normalize", () => {
    expect(contentHash("hello   world")).toBe(contentHash("hello world"))
  })
})

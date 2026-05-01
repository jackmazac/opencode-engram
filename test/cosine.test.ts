import { describe, expect, test } from "bun:test"
import { topKByCosine } from "../src/cosine.ts"

describe("topKByCosine", () => {
  test("ordering", () => {
    const q = new Float32Array([1, 0, 0])
    const rows = [
      { id: "a", blob: Buffer.from(new Float32Array([0.9, 0.1, 0]).buffer) },
      { id: "b", blob: Buffer.from(new Float32Array([0.1, 0.9, 0]).buffer) },
    ]
    const k = topKByCosine(q, rows, 1)
    expect(k[0]?.id).toBe("a")
  })

  test("skips vectors with mismatched dimensions", () => {
    const q = new Float32Array([1, 0, 0])
    const rows = [
      { id: "bad", blob: Buffer.from(new Float32Array([1, 0]).buffer) },
      { id: "good", blob: Buffer.from(new Float32Array([0.8, 0.2, 0]).buffer) },
    ]
    const k = topKByCosine(q, rows, 2)
    expect(k.map((x) => x.id)).toEqual(["good"])
  })
})

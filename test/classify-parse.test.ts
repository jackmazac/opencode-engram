import { describe, expect, test } from "bun:test"
import { parseClassifyJsonLine } from "../src/classify.ts"

describe("parseClassifyJsonLine", () => {
  test("valid line", () => {
    const r = parseClassifyJsonLine('{"id":"01","type":"plan","confidence":0.8}')
    expect(r).toEqual({ id: "01", type: "plan", confidence: 0.8 })
  })

  test("malformed json", () => {
    expect(parseClassifyJsonLine("{not json")).toBeUndefined()
  })

  test("non-object", () => {
    expect(parseClassifyJsonLine('"x"')).toBeUndefined()
  })
})

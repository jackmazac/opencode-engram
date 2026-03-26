/**
 * Hits OpenAI when the key resolves (`OPENAI_API_KEY`, config path N/A here, or macOS Keychain).
 */
import { describe, expect, test } from "bun:test"
import { defaultEngramConfig } from "../src/config.ts"
import {
  classifyBatchSchema,
  rerankIdsSchema,
  resolveApiKey,
  responsesStructured,
} from "../src/openai.ts"

const key = resolveApiKey()

if (!key) {
  describe.skip("live OpenAI gpt-5.4-nano", () => {})
} else {

  describe("live OpenAI gpt-5.4-nano", () => {
    const model = defaultEngramConfig.classify.model

    test(
      "responsesStructured classify batch",
      async () => {
        const r = await responsesStructured({
          key,
          model,
          instructions:
            "For each item id, output type as a short lowercase label (e.g. plan, note, error). Use the schema.",
          input: "Items with ids: a1, b2.",
          maxOutputTokens: 256,
          schemaName: "classify_batch",
          schema: classifyBatchSchema,
        })
        expect(Array.isArray(r.items)).toBe(true)
        expect(r.items.length).toBeGreaterThanOrEqual(1)
        for (const row of r.items) {
          expect(typeof row.id).toBe("string")
          expect(typeof row.type).toBe("string")
        }
      },
      { timeout: 120_000 },
    )

    test(
      "responsesStructured rerank ids",
      async () => {
        const r = await responsesStructured({
          key,
          model,
          instructions:
            "Rank passages by relevance to the query. Output ids in best-first order. Use only ids from the list.",
          input:
            "Query: authentication\n\nPassages:\n1. [p1] Session cookies and OAuth redirects\n2. [p2] Pasta carbonara steps",
          maxOutputTokens: 200,
          schemaName: "rerank_ids",
          schema: rerankIdsSchema,
        })
        expect(r.ids.length).toBeGreaterThan(0)
        expect(r.ids.every((id) => id === "p1" || id === "p2")).toBe(true)
      },
      { timeout: 120_000 },
    )
  })
}

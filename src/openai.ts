/**
 * OpenAI via Vercel AI SDK — API key resolution:
 * 1. `openaiApiKey` from config (plugin)
 * 2. `OPENAI_API_KEY`
 * 3. macOS Keychain generic password: service `OPENAI_KEYCHAIN_SERVICE` (default `OPENAI_API_KEY`), optional account `OPENAI_KEYCHAIN_ACCOUNT`
 *
 * Add example: `security add-generic-password -s OPENAI_API_KEY -a default -w "$(pbpaste)"`
 */

import { createOpenAI } from "@ai-sdk/openai"
import { embedMany, generateObject } from "ai"
import { z } from "zod"

export const classifyBatchSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      confidence: z.number().nullable(),
    }),
  ),
})

export type ClassifyBatch = z.infer<typeof classifyBatchSchema>

export const rerankIdsSchema = z.object({
  ids: z.array(z.string()),
})

export async function embedTexts(opts: {
  key: string
  model: string
  dimensions: number
  inputs: string[]
}): Promise<number[][]> {
  const client = createOpenAI({ apiKey: opts.key })
  const { embeddings } = await embedMany({
    model: client.embedding(opts.model),
    values: opts.inputs,
    maxRetries: 0,
    providerOptions: {
      openai: {
        dimensions: opts.dimensions,
      },
    },
  })
  return embeddings
}

/**
 * OpenAI Responses API + structured output (`generateObject` / json_schema).
 * @see https://developers.openai.com/api/docs/guides/migrate-to-responses
 */
export async function responsesStructured<T>(opts: {
  key: string
  model: string
  instructions: string
  input: string
  maxOutputTokens: number
  schemaName: string
  schema: z.ZodType<T>
}): Promise<T> {
  const client = createOpenAI({ apiKey: opts.key })
  const { object } = await generateObject({
    model: client.responses(opts.model),
    system: opts.instructions,
    prompt: opts.input,
    schema: opts.schema,
    schemaName: opts.schemaName,
    maxOutputTokens: opts.maxOutputTokens,
    maxRetries: 0,
    providerOptions: {
      openai: {
        store: false,
        reasoningEffort: "none",
        textVerbosity: "low",
      },
    },
  })
  return object
}

function keychainGenericSecret(service: string, account?: string): string | undefined {
  if (process.platform !== "darwin") return undefined
  const argv = ["find-generic-password", "-w", "-s", service]
  if (account) argv.push("-a", account)
  const proc = Bun.spawnSync(["security", ...argv], {
    stdout: "pipe",
    stderr: "ignore",
  })
  if (proc.exitCode !== 0) return undefined
  const text = new TextDecoder().decode(proc.stdout).trim()
  if (!text) return undefined
  return text
}

export function resolveApiKey(cfgKey?: string): string | undefined {
  if (cfgKey) return cfgKey
  const env = process.env.OPENAI_API_KEY
  if (env) return env
  const svc = process.env.OPENAI_KEYCHAIN_SERVICE ?? "OPENAI_API_KEY"
  const acct = process.env.OPENAI_KEYCHAIN_ACCOUNT
  return keychainGenericSecret(svc, acct)
}

import { createHash } from "node:crypto"

export function normalizeForHash(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

export function contentHash(s: string): string {
  return createHash("sha256").update(normalizeForHash(s), "utf8").digest("hex")
}

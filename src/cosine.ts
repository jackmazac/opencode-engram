/** Float32 BLOB from chunk.embedding — L2-normalized vectors from OpenAI */
export function blobToVec(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    d += x * y
  }
  return d
}

export function topKByCosine(
  query: Float32Array,
  rows: { id: string; blob: Buffer }[],
  k: number,
): { id: string; score: number }[] {
  const scored = rows
    .map((r) => ({ id: r.id, score: cosine(query, blobToVec(r.blob)) }))
    .filter((x) => Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

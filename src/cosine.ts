/** Float32 BLOB from chunk.embedding — L2-normalized vectors from OpenAI */
export function blobToVec(b: Buffer | Uint8Array): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Number.NaN
  let d = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    d += x * y
  }
  return d
}

export function topKByCosine(
  query: Float32Array,
  rows: Iterable<{ id: string; blob: Buffer | Uint8Array }>,
  k: number,
): { id: string; score: number }[] {
  if (k <= 0) return []
  const best: { id: string; score: number }[] = []
  for (const r of rows) {
    if (r.blob.byteLength !== query.byteLength) continue
    const score = cosine(query, blobToVec(r.blob))
    if (!Number.isFinite(score)) continue
    let i = best.length
    while (i > 0 && (best[i - 1]?.score ?? -Infinity) > score) i--
    best.splice(i, 0, { id: r.id, score })
    if (best.length > k) best.shift()
  }
  return best.reverse()
}

/** Reciprocal Rank Fusion — stable tie-break by earlier list order. */
export function rrfMerge(lists: string[][], k = 60): { id: string; score: number }[] {
  const scores = new Map<string, number>()
  const order = new Map<string, number>()
  let t = 0
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1))
      if (!order.has(id)) order.set(id, t++)
    })
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
    })
}

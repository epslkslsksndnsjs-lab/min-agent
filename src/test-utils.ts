// Shared helpers for the test suite.

/** Drive an async generator to completion and collect all yielded values. */
export async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

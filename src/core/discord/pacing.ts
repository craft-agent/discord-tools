/** Requests in one process are spaced by a random interval within these bounds. */
export const PACE_MIN_MS = 600
export const PACE_MAX_MS = 1600

let lastRequestAt: number | undefined
let queue: Promise<void> = Promise.resolve()

/** Forgets when the last request was sent; for tests that run many clients in one process. */
export function resetPacing(): void {
  lastRequestAt = undefined
  queue = Promise.resolve()
}

/**
 * Returns a function that waits for this process's turn to send: 0.6 to 1.6
 * seconds after the last request of any client, with concurrent callers served
 * one after another.
 */
export function createPacer(clock: {
  now: () => number
  sleep: (ms: number) => Promise<void>
  random: () => number
}): () => Promise<void> {
  return () => {
    const turn = queue.then(async () => {
      if (lastRequestAt !== undefined) {
        const interval = PACE_MIN_MS + clock.random() * (PACE_MAX_MS - PACE_MIN_MS)
        const wait = interval - Math.max(0, clock.now() - lastRequestAt)
        if (wait > 0) await clock.sleep(wait)
      }
      lastRequestAt = clock.now()
    })
    queue = turn.catch(() => {})
    return turn
  }
}

/** Shared polling helpers for subscribed threads, overlap-safe cursors, and timer-friendly delays. */
import { liveTicket, type Thread } from '../core/index.ts'
import type { SourceContext } from './host.ts'

/** How long a subscribed Thread with no live Ticket continues to be polled after its last Trigger or Ticket end. */
export const POLL_HORIZON_MS = 14 * 24 * 3600_000
/** True when a subscribed thread has a live ticket or recent activity/completion within `POLL_HORIZON_MS`. */
export function polled(ctx: SourceContext, thread: Thread, now = Date.now()): boolean {
  const tickets = thread.subscriptions.map(id => ctx.tickets.get(id))
  if (tickets.some(ticket => !!ticket && liveTicket(ticket))) return true
  const times = [thread.lastAt ?? thread.createdAt, ...tickets.map(ticket => ticket?.ended?.at ?? '')]
    .map(Date.parse).filter(Number.isFinite)
  return now - Math.max(...times) < POLL_HORIZON_MS
}
/** Steps a poll start timestamp back by 5 seconds so late-arriving remote events are not missed; deterministic trigger IDs deduplicate overlaps. */
export const cursorAt = (started: string): string => new Date(Date.parse(started) - 5000).toISOString()
/** Polls each subscribed Thread of `source` within the horizon independently; records failures on the Thread as `pollError` (unless `stopped()`) and clears `pollError` on success. */
export async function pollThreads(ctx: SourceContext, source: string, stopped: () => boolean, poll: (thread: Thread) => Promise<void>,
  skip: (thread: Thread) => boolean = () => false): Promise<void> {
  const threads = ctx.threads.subscribed(source).filter(thread => !skip(thread) && polled(ctx, thread))
  await eachLimit(threads, POLL_CONCURRENCY, async thread => {
    if (stopped()) return
    try {
      await poll(thread)
      ctx.threads.patch(thread.key, { pollError: undefined })
    } catch (error) {
      if (stopped()) return
      ctx.threads.patch(thread.key, { pollError: String(error) })
    }
  })
}
/** How many GitHub reads of one kind may run at once: enough to keep a round short, few enough to stay polite. */
export const POLL_CONCURRENCY = 4
/** Runs `run` over `items` with at most `limit` in flight: a round of GitHub reads must fit in one poll interval. */
export async function eachLimit<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  const queue = items.slice()
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item)
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, worker))
}
/** Waits `ms` or until `signal` aborts using global `setTimeout` so test fake timers can drive polling loops. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const stop = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
}

/**
 * Runs a cleanup command for each Ticket once it ends, so finished workspaces do not accumulate.
 * A disabled command keeps every directory, which is the default: cleanup is opt-in.
 */
import { dirname } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { liveTicket, type Ticket } from '../core/index.ts'
import { runAsWorker } from '../infra/environment.ts'
import { KV } from '../kv.ts'
import { FAILURES_BEFORE_ERROR, type Effects } from './effects.ts'
import type { Store } from './store.ts'

/** Maximum runtime for one cleanup command; a hung command must not hold the queue. */
export const CLEANUP_TIMEOUT_MS = 10 * 60_000
/** A catch-up only: a Ticket that ended while the host was down is collected on the next sweep. */
const SWEEP_MS = 3 * 3600_000

/**
 * How long a Ticket stays ended before its workspace may be removed. A message on any of its Threads resumes it, and the
 * merge that ended it is usually followed by one, so a workspace removed at once is one a resuming worker still needs.
 */
export const CLEANUP_GRACE_MS = 10 * 60_000

/**
 * True when an ended Ticket has a directory and no recorded attempt, and nothing has happened to it since it ended:
 * cleanup runs once per Ticket, and never while a resumed worker may still be using the workspace.
 */
export function needsCleanup(
  ticket: Pick<Ticket, 'ended' | 'execution' | 'id' | 'assignments'>,
  recorded: string | undefined,
  now = Date.now(),
): boolean {
  if (!ticket.ended || !ticket.execution?.directory || recorded !== undefined) return false
  const endedAt = Date.parse(ticket.ended.at)
  if (now - endedAt < CLEANUP_GRACE_MS) return false
  // An assignment made after the end means the Ticket resumed: it is finished only when it ends again, with a newer date.
  return !(ticket.assignments ?? []).some(assignment => Date.parse(assignment.createdAt) > endedAt)
}

export interface CleanupHost {
  store: Store
  effects: Pick<Effects, 'enqueue' | 'handle' | 'cancel'>
  subprocess: SubprocessRuntime
  /** The execution environment variables of a Ticket, as its prepare command receives them. */
  environment: (ticket: Ticket) => { key: string; value: string }[]
  lifetime: AbortSignal
  closing: () => boolean
}

/** Runs the cleanup command once per ended Ticket, and sweeps for Tickets that ended while the host was down. */
export class Cleanup {
  private timer?: ReturnType<typeof setInterval>

  constructor(private readonly host: CleanupHost) {}

  start(): void {
    this.host.effects.handle('cleanup', async ({ ticketId }) => { await this.run(ticketId) }, { limit: () => 1, retry: [5000, 120_000] })
    this.sweep()
    this.timer = setInterval(() => { this.sweep() }, SWEEP_MS)
  }

  stop(): void {
    clearInterval(this.timer)
  }

  /** Enqueues cleanup for one Ticket that just ended; a disabled command keeps every directory. */
  request(ticketId: string): void {
    if (this.host.closing() || !this.host.store.settings().executor.cleanup.trim()) return
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !needsCleanup(ticket, this.host.store.get(KV.cleanup(ticketId)))) return
    this.host.effects.enqueue('cleanup', ticket.id, { ticketId: ticket.id })
  }

  /** A resumed Ticket keeps its workspace, so a cleanup queued for its earlier end is pointless. */
  forget(ticketId: string): void {
    this.host.effects.cancel('cleanup', ticketId)
  }

  /** Enqueues one cleanup per ended Ticket that no earlier attempt recorded; a disabled command keeps every directory. */
  sweep(): void {
    if (this.host.closing() || !this.host.store.settings().executor.cleanup.trim()) return
    for (const ticket of this.host.store.tickets.list()) {
      if (!needsCleanup(ticket, this.host.store.get(KV.cleanup(ticket.id)))) continue
      this.host.effects.enqueue('cleanup', ticket.id, { ticketId: ticket.id })
    }
  }

  private async run(ticketId: string): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const command = this.host.store.settings().executor.cleanup.trim()
    const directory = ticket?.execution?.directory ?? ''
    const recorded = this.host.store.get(KV.cleanup(ticketId))
    // A resumed Ticket is not cleaned, a command removed meanwhile keeps the directory, and the grace period has to pass.
    if (!ticket || !command || !directory || !needsCleanup(ticket, recorded, Date.now())) return
    const attemptsText = recorded ?? ''
    const attempts = Number(/^failed:(\d+)/.exec(attemptsText)?.[1] ?? 0)
    const environment = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)])
    try {
      await runAsWorker(this.host.subprocess, ['sh', '-c', command], dirname(directory), signal, environment)
      // A message can resume a Ticket while the command runs, and the command may already have removed the workspace: record
      // that rather than claiming a clean removal, so a person can see why a worker lost its checkout.
      const after = this.host.store.tickets.get(ticketId)
      const resumed = after && liveTicket(after)
      this.host.store.set(KV.cleanup(ticketId),
        resumed ? `interrupted:${new Date().toISOString()}` : `ok:${new Date().toISOString()}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const next = attempts + 1
      this.host.store.set(KV.cleanup(ticketId), `failed:${next}:${message.slice(0, 300)}`)
      // A refusal, such as uncommitted work the command declined to delete, needs a person: stop after the same threshold.
      if (next < FAILURES_BEFORE_ERROR && !this.host.closing()) throw error
    }
  }
}

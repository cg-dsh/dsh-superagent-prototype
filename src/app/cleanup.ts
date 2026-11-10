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
/** How often ended Tickets are checked for cleanup, so an end while the host was down is still collected. */
const SWEEP_MS = 60_000

/** True when an ended Ticket has a directory and no recorded attempt: cleanup runs once per Ticket. */
export function needsCleanup(ticket: Pick<Ticket, 'ended' | 'execution' | 'id'>, recorded: string | undefined): boolean {
  return !!ticket.ended && !!ticket.execution?.directory && recorded === undefined
}

export interface CleanupHost {
  store: Store
  effects: Pick<Effects, 'enqueue' | 'handle'>
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
    // A resumed Ticket is not cleaned, and a command removed meanwhile keeps the directory.
    if (!ticket || liveTicket(ticket) || !command || !directory) return
    const recorded = this.host.store.get(KV.cleanup(ticketId)) ?? ''
    const attempts = Number(/^failed:(\d+)/.exec(recorded)?.[1] ?? 0)
    const environment = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)])
    try {
      await runAsWorker(this.host.subprocess, ['sh', '-c', command], dirname(directory), signal, environment)
      this.host.store.set(KV.cleanup(ticketId), `ok:${new Date().toISOString()}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const next = attempts + 1
      this.host.store.set(KV.cleanup(ticketId), `failed:${next}:${message.slice(0, 300)}`)
      // A refusal, such as uncommitted work the command declined to delete, needs a person: stop after the same threshold.
      if (next < FAILURES_BEFORE_ERROR && !this.host.closing()) throw error
    }
  }
}

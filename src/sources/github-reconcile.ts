/** Per-Ticket reconciliation scheduling for the GitHub Source: an idle Ticket is reconciled less often, so its pull
 * requests, checks and Issue state cost no GitHub read while nothing changes. */
import { KV } from '../kv.ts'
import type { SourceContext } from './host.ts'

/** One minute in milliseconds, the unit of the reconciliation ladder. */
const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** What a Ticket's reconciliation keeps between rounds: when it last ran, when its Ticket was last active, and what it
 * observed. The fingerprint holds the two observations a round's reads fill, `pulls` and `issue`. */
export interface ReconcileSchedule { at: string; activeAt: string; fingerprint: string }
/** What one reconciliation observed: the pull requests it read and the Issue state its Ticket started from, each as stable text. */
export interface ReconcileObservations { pulls: string; issue: string }

/**
 * How long a Ticket's reconciliation waits after its last one, by how long the Ticket has been idle: up to five minutes
 * every round (`0`), then every 2, 5, 15 or 30 minutes, and at most hourly. Each bucket begins at its boundary.
 */
export function reconcileInterval(idleMs: number): number {
  if (idleMs >= 12 * HOUR) return 60 * MINUTE
  if (idleMs >= 4 * HOUR) return 30 * MINUTE
  if (idleMs >= 1 * HOUR) return 15 * MINUTE
  if (idleMs >= 15 * MINUTE) return 5 * MINUTE
  if (idleMs >= 5 * MINUTE) return 2 * MINUTE
  return 0
}

/** The reconciliation schedule of a Ticket, when it has one. */
export function scheduleOf(ctx: SourceContext, ticketId: string): ReconcileSchedule | undefined {
  return ctx.state.get(KV.github.reconcile(ticketId))
}

/** True when this round owes a Ticket a reconciliation: it has none yet, or the interval its idle time earns has passed since it last ran. */
export function reconciliationDue(schedule: ReconcileSchedule | undefined, now: number): boolean {
  if (!schedule) return true
  const ranAt = Date.parse(schedule.at)
  if (!Number.isFinite(ranAt)) return true
  const activeAt = Date.parse(schedule.activeAt)
  const idle = Number.isFinite(activeAt) ? Math.max(0, now - activeAt) : 0
  return now - ranAt >= reconcileInterval(idle)
}

/** Marks a Ticket active at `at`, which resets its ladder to the top bucket; it reads nothing by itself. */
export function noteActivity(ctx: SourceContext, ticketId: string, at: string): void {
  const schedule = scheduleOf(ctx, ticketId)
  if (!schedule || Date.parse(schedule.activeAt) >= Date.parse(at)) return
  ctx.state.set(KV.github.reconcile(ticketId), { ...schedule, activeAt: at })
}

/** The observations of a stored fingerprint; undefined when there is none or it cannot be read, so the next one counts as a change. */
function observations(fingerprint: string | undefined): ReconcileObservations | undefined {
  try {
    const parsed = JSON.parse(fingerprint ?? '') as Partial<Record<keyof ReconcileObservations, unknown>>
    return typeof parsed.pulls === 'string' && typeof parsed.issue === 'string' ? { pulls: parsed.pulls, issue: parsed.issue } : undefined
  } catch { return undefined }
}

/**
 * Records a reconciliation that ran in full at `at`. A different fingerprint is activity too, so a change observed without a
 * Ticket transition resets the ladder; otherwise the ladder keeps counting from the Ticket's last activity.
 */
export function noteReconciliation(ctx: SourceContext, ticketId: string, observed: ReconcileObservations, at: string): void {
  const schedule = scheduleOf(ctx, ticketId)
  const changed = !schedule || observations(schedule.fingerprint) === undefined
    || JSON.stringify({ pulls: observed.pulls, issue: observed.issue }) !== schedule.fingerprint
  ctx.state.set(KV.github.reconcile(ticketId), { at, activeAt: !schedule || changed ? at : schedule.activeAt,
    fingerprint: JSON.stringify({ pulls: observed.pulls, issue: observed.issue }) })
}

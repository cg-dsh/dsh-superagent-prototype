/**
 * Builds the handover a fresh orchestrator session starts from.
 *
 * The orchestrator routes Tickets; its state is the Ticket map and its recent decisions, not a narrative. Rebuilding those
 * from the store is deterministic and cannot lose a Ticket the way a model summary can, and it costs a fraction of the
 * context it replaces.
 */
import { ticketCard } from './cards.ts'
import type { Decision, Ticket } from '../core/index.ts'

/** The prompt size above which the orchestrator session is replaced before its next delivery. */
export const MASTER_CONTEXT_LIMIT = 300_000
/** How far back the recent window reaches, before its floor is applied. */
export const RECENT_DAYS = 7
/** The least a handover carries, so a quiet week does not produce an empty handover. */
export const MIN_RECENT = 10

export interface HandoverSource {
  tickets: readonly Ticket[]
  decisions: readonly Decision[]
  /** The last thing the replaced session said, when it said anything. */
  verdict?: string
  /** When the replaced session was retired. */
  at: string
}

/** One line per thread that saw decisions in the window: how many, and how the last one went. */
function collapsed(decisions: readonly Decision[]): string[] {
  const perThread = new Map<string, { count: number; last: string }>()
  for (const decision of decisions) {
    const entry = perThread.get(decision.threadKey) ?? { count: 0, last: '' }
    entry.count += 1
    entry.last = decision.kind
    perThread.set(decision.threadKey, entry)
  }
  return [...perThread.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]))
    .map(([thread, entry]) => `- ${thread}: ${entry.count} decision(s), last ${entry.last}`)
}

/** The handover text: open Tickets and recently ended ones as the notices they already know, then decisions by thread. */
export function handover(source: HandoverSource): string {
  const open = source.tickets.filter(ticket => !ticket.ended)
  const ended = source.tickets
    .filter(ticket => ticket.ended)
    .sort((left, right) => right.ended!.at.localeCompare(left.ended!.at))
  const newest = ended[0] ? Date.parse(ended[0].ended!.at) : Date.parse(source.at)
  const cutoff = new Date(newest - RECENT_DAYS * 24 * 60 * 60_000).toISOString()
  const recent = ended.filter(ticket => ticket.ended!.at >= cutoff)
  const window = recent.length >= MIN_RECENT ? recent : ended.slice(0, MIN_RECENT)
  const decisions = source.decisions.filter(decision => decision.at >= cutoff)

  const lines = [
    '# Handover from the previous orchestrator session',
    '',
    `It was replaced at ${source.at} once its prompt passed ${MASTER_CONTEXT_LIMIT.toLocaleString('en')} tokens.`,
    'Nothing was lost: the Tickets below are current, and the previous session stays readable on disk.',
    '',
    `## Open tickets (${open.length})`,
  ]
  // The same card shape the notices use, so the orchestrator reads them without a new format to learn.
  for (const ticket of open) lines.push(JSON.stringify({ ticket: ticketCard(ticket) }))
  lines.push('', `## Recently ended (${window.length}, last ${RECENT_DAYS} days)`)
  for (const ticket of window) {
    const { preview: _preview, ...card } = ticketCard(ticket)
    lines.push(JSON.stringify({ ticket_ended: card }))
  }
  const threads = collapsed(decisions)
  lines.push('', `## Decisions by thread (${threads.length}, last ${RECENT_DAYS} days, collapsed)`)
  lines.push(...threads)
  if (source.verdict) lines.push('', '## Your last verdict', source.verdict.slice(0, 600))
  return lines.join('\n')
}

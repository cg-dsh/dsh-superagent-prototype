import { describe, expect, it } from 'vitest'
import { CLEANUP_GRACE_MS, needsCleanup } from '../src/app/cleanup.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'
import type { Ticket } from '../src/core/index.ts'

const ended = { at: '2026-09-23T00:00:00Z', by: 'executor' as const, outcome: 'merged' as const }
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ id: 't', ended, execution: { name: 'n', directory: '/work/n', assignment: '' }, ...overrides }) as Ticket

describe('cleaning up a finished Ticket', () => {
  it('cleans an ended Ticket with a directory that no earlier attempt recorded', () => {
    expect(needsCleanup(ticket(), undefined)).toBe(true)
  })
  it('waits out the grace period: a merge is usually followed by a message that resumes the Ticket', () => {
    const recently = { at: new Date(Date.now() - 60_000).toISOString(), by: 'executor' as const, outcome: 'merged' as const }
    expect(needsCleanup(ticket({ ended: recently }), undefined)).toBe(false)
    const settled = { at: new Date(Date.now() - CLEANUP_GRACE_MS - 60_000).toISOString(), by: 'executor' as const, outcome: 'merged' as const }
    expect(needsCleanup(ticket({ ended: settled }), undefined)).toBe(true)
  })
  it('leaves a Ticket that resumed after it ended, even once the grace period has passed', () => {
    const endedAt = '2026-09-23T00:00:00Z'
    const resumed = ticket({ assignments: [{ id: 'a', state: 'ended', createdAt: '2026-09-23T00:05:00Z' }] as Ticket['assignments'] })
    expect(needsCleanup(resumed, undefined, Date.parse('2026-09-23T01:00:00Z'))).toBe(false)
    const untouched = ticket({ assignments: [{ id: 'a', state: 'ended', createdAt: '2026-09-22T23:00:00Z' }] as Ticket['assignments'] })
    expect(needsCleanup(untouched, undefined, Date.parse(endedAt) + 3_600_000)).toBe(true)
  })
  it('leaves a live Ticket and a Ticket that never prepared a directory alone', () => {
    expect(needsCleanup(ticket({ ended: undefined }), undefined)).toBe(false)
    expect(needsCleanup(ticket({ execution: { name: 'n', directory: '', assignment: '' } }), undefined)).toBe(false)
  })
  it('runs once per Ticket: any recorded attempt, worked or refused, stops the next one', () => {
    expect(needsCleanup(ticket(), 'ok:2026-09-23T00:01:00Z')).toBe(false)
    expect(needsCleanup(ticket(), 'failed:3:uncommitted changes')).toBe(false)
  })
  it('keeps every directory until an operator sets a command', () => {
    expect(ExecutorConfigSchema.parse({}).cleanup).toBe('')
  })
})

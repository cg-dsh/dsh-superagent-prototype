/** Cover the handover a replacement orchestrator session starts from. */

import { describe, expect, it } from 'vitest'
import { handover, MIN_RECENT, RECENT_DAYS } from '../src/app/handover.ts'
import type { Decision, Ticket } from '../src/core/index.ts'

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 'a'.repeat(32),
  title: 'Fix the thing',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
  threads: [{ source: 'github', id: '10' }],
  mandate: { strength: 'inferred' },
  assignments: [{ id: 'w', state: 'ended', createdAt: '2026-11-01T00:00:00.000Z',
    report: { state: 'ready', summary: 'done', at: '2026-11-01T01:00:00.000Z' } }],
  inputs: [],
  undelivered: [],
  ...overrides,
} as Ticket)

const decision = (threadKey: string, kind: Decision['kind'], at: string): Decision =>
  ({ id: `${threadKey}-${at}`, kind, threadKey, at } as Decision)

describe('the orchestrator handover', () => {
  it('carries open Tickets as the cards the notices already use', () => {
    const text = handover({ tickets: [ticket()], decisions: [], at: '2026-11-17T00:00:00.000Z' })
    expect(text).toContain('## Open tickets (1)')
    expect(text).toContain('"state":"person/review"')
    expect(text).toContain('"read":"ticket/')
  })

  it('leaves the preview off an ended Ticket, and keeps what identifies it', () => {
    const ended = ticket({ id: 'b'.repeat(32), ended: { at: '2026-11-16T00:00:00.000Z', by: 'executor', outcome: 'merged' } })
    const text = handover({ tickets: [ended], decisions: [], at: '2026-11-17T00:00:00.000Z' })
    expect(text).toContain('"ticket_ended"')
    expect(text).toContain('"reason":"merged"')
    expect(text).not.toContain('"preview"')
  })

  it('collapses decisions per thread, most active first, instead of listing every one', () => {
    const decisions = [
      decision('github:1', 'ignore', '2026-11-16T01:00:00.000Z'),
      decision('github:1', 'ignore', '2026-11-16T02:00:00.000Z'),
      decision('github:2', 'accept', '2026-11-16T03:00:00.000Z'),
    ]
    const text = handover({ tickets: [], decisions, at: '2026-11-17T00:00:00.000Z' })
    expect(text).toContain('- github:1: 2 decision(s), last ignore')
    expect(text).toContain('- github:2: 1 decision(s), last accept')
  })

  it('drops decisions older than the window and keeps a floor of recent Tickets', () => {
    const old = decision('github:9', 'ignore', '2026-01-01T00:00:00.000Z')
    const text = handover({ tickets: [], decisions: [old], at: '2026-11-17T00:00:00.000Z' })
    expect(text).toContain('## Decisions by thread (0')
    const ended = Array.from({ length: MIN_RECENT + 2 }, (_, index) => ticket({
      id: String(index).padStart(32, '0'),
      ended: { at: `2026-11-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`, by: 'executor', outcome: 'merged' },
    }))
    const floored = handover({ tickets: ended, decisions: [], at: '2026-11-17T00:00:00.000Z' })
    expect(floored).toContain(`## Recently ended (${MIN_RECENT},`)
  })

  it('carries the last verdict and says where it came from', () => {
    const text = handover({ tickets: [], decisions: [], verdict: 'Issue #1489 is in Testing', at: '2026-11-17T00:00:00.000Z' })
    expect(text).toContain('## Your last verdict')
    expect(text).toContain('Issue #1489 is in Testing')
    expect(text).toContain(`${RECENT_DAYS} days`)
  })
})

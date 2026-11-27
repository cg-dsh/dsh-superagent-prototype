import { expect, it } from 'vitest'
import type { SourceContext } from '../src/sources/host.ts'
import { noteActivity, noteReconciliation, reconcileInterval, reconciliationDue, scheduleOf }
  from '../src/sources/github-reconcile.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

it('waits longer after each idle bucket, from every round to one hour', () => {
  // The ladder of the operator's table: idle time at the top of each bucket, then the interval it earns.
  const ladder: [number, number][] = [
    [0, 0], [5 * MINUTE - 1, 0], [5 * MINUTE, 2 * MINUTE],
    [15 * MINUTE - 1, 2 * MINUTE], [15 * MINUTE, 5 * MINUTE],
    [HOUR - 1, 5 * MINUTE], [HOUR, 15 * MINUTE],
    [4 * HOUR - 1, 15 * MINUTE], [4 * HOUR, 30 * MINUTE],
    [12 * HOUR - 1, 30 * MINUTE], [12 * HOUR, 60 * MINUTE],
    [100 * HOUR, 60 * MINUTE],
  ]
  for (const [idle, wait] of ladder) expect([idle, reconcileInterval(idle)]).toEqual([idle, wait])
  // A clock that moved back is as fresh as activity can be.
  expect(reconcileInterval(-1)).toBe(0)
})

it('owes a reconciliation at once until one ran, then only once its idle interval has passed', () => {
  const now = Date.parse('2026-11-27T12:00:00.000Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()
  const schedule = (ran: number, active: number) => ({ at: ago(ran), activeAt: ago(active), fingerprint: '{"pulls":"[]","issue":"[]"}' })
  expect(reconciliationDue(undefined, now)).toBe(true)
  // Less than five minutes idle is the top bucket: a reconciliation every round, however recently one ran.
  expect(reconciliationDue(schedule(MINUTE, MINUTE), now)).toBe(true)
  // Ten minutes idle earns every two minutes, so ten and eleven minutes after the last run are not due yet.
  expect(reconciliationDue(schedule(MINUTE, 10 * MINUTE), now)).toBe(false)
  expect(reconciliationDue(schedule(3 * MINUTE, 10 * MINUTE), now)).toBe(true)
  // A long idle Ticket is owed its reconciliation hourly and no sooner.
  expect(reconciliationDue(schedule(59 * MINUTE, 13 * HOUR), now)).toBe(false)
  expect(reconciliationDue(schedule(HOUR, 13 * HOUR), now)).toBe(true)
  // A stored record without a readable run time is as owed as one that never ran.
  expect(reconciliationDue({ at: '', activeAt: '', fingerprint: '' }, now)).toBe(true)
})

/** A Source context whose KV state lives in a map, enough to test the schedule records. */
function context(): SourceContext {
  const values = new Map<string, unknown>()
  return { state: {
    get: <V>(key: string) => values.get(key) as V | undefined,
    set: <V>(key: string, value: V | undefined) => { if (value === undefined) values.delete(key); else values.set(key, value) },
  } } as unknown as SourceContext
}
const at1 = '2026-11-27T10:00:00.000Z', at2 = '2026-11-27T10:10:00.000Z', at3 = '2026-11-27T10:20:00.000Z'

it('records each run, and counts only a changed observation as activity', () => {
  const ctx = context()
  expect(scheduleOf(ctx, 't')).toBeUndefined()
  noteReconciliation(ctx, 't', { pulls: '[]', issue: '[]' }, at1)
  expect(scheduleOf(ctx, 't')).toEqual({ at: at1, activeAt: at1, fingerprint: '{"pulls":"[]","issue":"[]"}' })
  // The same observation leaves the activity stamp where it was, so the ladder keeps counting from it.
  noteReconciliation(ctx, 't', { pulls: '[]', issue: '[]' }, at2)
  expect(scheduleOf(ctx, 't')).toEqual({ at: at2, activeAt: at1, fingerprint: '{"pulls":"[]","issue":"[]"}' })
  // A change is activity too, which resets the ladder.
  noteReconciliation(ctx, 't', { pulls: '[]', issue: '["issue:12:closed:2026-11-27T10:19:00.000Z"]' }, at3)
  const changed = scheduleOf(ctx, 't')!
  expect(changed).toMatchObject({ at: at3, activeAt: at3 })
  expect(JSON.parse(changed.fingerprint)).toEqual({ pulls: '[]', issue: '["issue:12:closed:2026-11-27T10:19:00.000Z"]' })
  // A stored fingerprint that cannot be read counts as a change, so the next run is written cleanly.
  ctx.state.set('github-reconcile:t', { at: at3, activeAt: at1, fingerprint: 'not a fingerprint' })
  noteReconciliation(ctx, 't', { pulls: '[]', issue: '[]' }, at1)
  expect(scheduleOf(ctx, 't')).toEqual({ at: at1, activeAt: at1, fingerprint: '{"pulls":"[]","issue":"[]"}' })
})

it('resets the ladder to the top bucket on activity, without reading anything or moving it backwards', () => {
  const ctx = context()
  noteReconciliation(ctx, 't', { pulls: '[]', issue: '[]' }, at1)
  noteActivity(ctx, 't', at3)
  expect(scheduleOf(ctx, 't')).toEqual({ at: at1, activeAt: at3, fingerprint: '{"pulls":"[]","issue":"[]"}' })
  noteActivity(ctx, 't', at2)
  expect(scheduleOf(ctx, 't')?.activeAt).toBe(at3)
  // A Ticket with no schedule has nothing to stamp: it is due as a first sight.
  noteActivity(ctx, 'other', at3)
  expect(scheduleOf(ctx, 'other')).toBeUndefined()
})

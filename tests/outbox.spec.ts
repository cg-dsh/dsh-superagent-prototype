/** Outbox delivery when processing is paused or a Source kind registers late. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
}

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  lark.mockClear()
  h.runtime.outbox.send({ id: 'held', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('held'), lark.mock.calls.length]).toEqual(['pending', 0])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('held')).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('keeps a message for a Source that is not installed waiting, and sends it once the Source\'s kind registers', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('waiting'), h.runtime.health.reply?.state]).toEqual(['pending', 'ready'])
  h.runtime.sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  await at(5000)
  expect([h.runtime.outbox.status('waiting'), sent.map(message => message.id)]).toEqual(['sent', ['waiting']])
})

/** A GitHub reply to an Issue, as a source context would queue it. */
const goneChannel = { source: 'github', thread: 'github:1542',
  address: { number: '1542', url: 'https://github.com/acme/widgets/issues/1542' } }
const refuse = (status: number, text: string) => commandError({ stderr: `gh: ${text} (HTTP ${status})`, code: 1 })

it('drops a reply GitHub says is gone, and the reply health recovers from its earlier retries', async () => {
  const gh = vi.mocked(Commands.prototype.gh)
  h.runtime.outbox.send({ id: 'gone-404', channel: goneChannel, text: 'Done', kind: 'reply' })
  gh.mockRejectedValue(refuse(502, 'Bad Gateway'))
  await h.runtime.sendReplies()
  await at(5000); await at(15_000)
  // Three failed attempts make the reply health an error, as it was in the deployment.
  expect(h.runtime.health.reply).toMatchObject({ state: 'error' })
  // GitHub no longer has the Issue: the receipt settles dropped instead of retrying, so nothing waits and health clears.
  gh.mockRejectedValue(refuse(404, 'Not Found'))
  await at(40_000)
  expect([h.runtime.outbox.status('gone-404'), h.runtime.store.receipts.get('gone-404')?.dropped?.reason])
    .toEqual(['dropped', 'channelGone'])
  expect(h.runtime.health.reply).toMatchObject({ state: 'ready', detail: 'Nothing waiting' })
})

it('drops a 410 reply as gone, and keeps a transient 502 reply retrying', async () => {
  const gh = vi.mocked(Commands.prototype.gh)
  let attempts = 0
  gh.mockImplementation(async () => { attempts += 1; throw refuse(410, 'This issue was deleted') })
  h.runtime.outbox.send({ id: 'gone-410', channel: goneChannel, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('gone-410'), h.runtime.store.receipts.get('gone-410')?.dropped?.reason])
    .toEqual(['dropped', 'channelGone'])
  attempts = 0
  gh.mockImplementation(async () => { attempts += 1; throw refuse(502, 'Bad Gateway') })
  h.runtime.outbox.send({ id: 'retry-502', channel: goneChannel, text: 'Done again', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('retry-502'), attempts]).toEqual(['pending', 1])
  // The retry due after five seconds runs, and the receipt is still pending rather than dropped.
  await at(5000)
  expect([h.runtime.outbox.status('retry-502'), attempts]).toEqual(['pending', 2])
})

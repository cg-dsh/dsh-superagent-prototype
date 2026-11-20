import { afterEach, expect, it, vi } from 'vitest'
import { admissionContext, threadWindow } from '../src/sources/admission-context.ts'
import { Commands } from '../src/infra/commands.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import type { ContextMessage } from '../src/sources/kind.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import { testDeployment } from './fixtures/deployment.ts'
import type { Trigger } from '../src/core/index.ts'
const message = (index: number): ContextMessage => ({ id: `om_${index}`, from: 'ou_user', at: String(index), text: `Message ${index}` })
afterEach(() => vi.restoreAllMocks())
/** The same message as a Feishu topic page lists it. */
const listed = (index: number) => ({ message_id: `om_${index}`, chat_id: 'oc_chat', content: `Message ${index}`, msg_type: 'text',
  sender: { id: 'ou_user', sender_type: 'user' }, create_time: String(index) })
it('returns the thread opening and trigger neighbors with exact internal and trailing gaps', () => {
  const result = threadWindow(Array.from({ length: 40 }, (_, i) => message(i)), 'om_25')
  expect(result.entries.map((item: { position: number }) => item.position)).toEqual([1, 2, 3, 4, 5, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31])
  expect(result.entries[5]?.omitted_before).toBe(15)
  expect(result.omitted_after).toBe(9)
  expect(result.source_found).toBe(true)
})
it('deduplicates overlapping windows and reports an absent source without inventing neighbors', () => {
  const messages = Array.from({ length: 12 }, (_, i) => message(i))
  expect(threadWindow(messages, 'om_3').entries.map((item: { position: number }) => item.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  expect(threadWindow(messages, 'om_absent')).toMatchObject({ source_found: false, loaded_messages: 12, omitted_after: 7 })
})
it('retains pagination limits and exact loaded counts rather than claiming complete history', async () => {
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const lark = vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [{ message_id: 'om_9', chat_id: 'oc_chat', thread_id: 'omt_thread' }] })
    .mockResolvedValueOnce({ thread_id: 'omt_thread', messages: [listed(0), listed(1)], has_more: true, page_token: 'next' })
  const trigger: Trigger = { id: 'event', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_chat:om_9' }], actor: { source: 'feishu', id: 'ou_user' }, human: true, text: 'Trigger', at: '', meta: { chatId: 'oc_chat', messageId: 'om_9', direct: false, mentioned: false } }
  const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { readPageSize: 2 } } } }))
  sources.register(feishuKind)
  const result = await admissionContext(sources.threadContext(trigger)!, commands, 1)
  expect(result).toMatchObject({ complete: false, next: 'next', window: { loaded_messages: 2, source_found: false } })
  expect(lark).toHaveBeenCalledTimes(2)
  expect(lark.mock.calls[1]![0]).toEqual(expect.arrayContaining(['--page-size', '2']))
})
it('assembles a qualified GitHub Issue thread in its own repository and finds its source', async () => {
  const deployment = testDeployment({ repository: 'acme/widgets', repositories: ['acme/widgets', 'acme/other'] })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const url = 'https://github.com/acme/other/issues/517'
  const issue = { id: 1, number: 517, title: 'Renovate', state: 'open', body: 'Update dependencies', user: { login: 'bob' },
    created_at: '2026-09-09T00:00:00Z', html_url: url }
  const paths: string[] = []
  vi.spyOn(Commands.prototype, 'run').mockImplementation(async (_program, args) => {
    paths.push(args[1]!)
    if (args[1]!.includes('/comments')) return '[]'
    // The primary answers with a pull request of the same number; the qualified thread must not read it.
    if (args[1]!.startsWith('repos/acme/widgets/')) return JSON.stringify({ ...issue,
      html_url: 'https://github.com/acme/widgets/pull/517', pull_request: { url: 'x' } })
    return JSON.stringify(issue)
  })
  const trigger: Trigger = { id: 'other-517', source: 'github', threads: [{ source: 'github', id: 'acme/other#517' }],
    actor: { source: 'github', id: 'bob' }, human: true, at: '2026-09-09T00:00:00Z', text: 'Renovate', url,
    meta: { number: 517, kind: 'issue' } }
  const sources = new SourceRegistry(() => SettingsSchema.parse({ sources: { github: { enabled: true,
    config: { repository: 'acme/widgets', repositories: ['acme/other'] } } } }))
  sources.register(githubKind)
  const result = await admissionContext(sources.threadContext(trigger)!, commands, 1)
  expect(result.window).toMatchObject({ source_found: true, loaded_messages: 1 })
  expect(result.messages).toEqual([expect.objectContaining({ id: url, text: 'Renovate\n\nUpdate dependencies' })])
  expect(paths).toEqual(['repos/acme/other/issues/517', 'repos/acme/other/issues/517/comments?per_page=100&page=1'])
  expect(paths.some(path => path.startsWith('repos/acme/widgets/') || path.includes('/pulls/'))).toBe(false)
})

it('gives a message outside a topic the five chat messages before it, and says it read the chat', async () => {
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const at = Date.parse('2026-09-11T12:00:00Z')
  const item = (n: number) => ({ message_id: `om_${n}`, chat_id: 'oc_chat', create_time: String(at + n * 1000), sender: { id: 'ou_user', sender_type: 'user' },
    body: { content: JSON.stringify({ text: `message ${n}` }) } })
  const lark = vi.spyOn(commands, 'lark').mockResolvedValueOnce({ items: [{ message_id: 'om_0', chat_id: 'oc_chat' }] })
    .mockResolvedValueOnce({ items: [0, -1, -2, -3, -4, -5].map(item), has_more: true, page_token: 'older' })
  const trigger: Trigger = { id: 'event', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_chat:om_0' }], actor: { source: 'feishu', id: 'ou_user' },
    human: true, text: 'message 0', at: new Date(at).toISOString(), meta: { chatId: 'oc_chat', messageId: 'om_0', direct: false, mentioned: false } }
  const sources = new SourceRegistry(() => SettingsSchema.parse({}))
  sources.register(feishuKind)
  const result = await admissionContext(sources.threadContext(trigger)!, commands, 3)
  expect(result).toMatchObject({ status: 'chat_neighbours', complete: true, window: { source_found: true, loaded_messages: 6 } })
  expect(result.messages.map(message => message.id)).toEqual([-5, -4, -3, -2, -1, 0].map(n => `om_${n}`))
  expect(lark).toHaveBeenCalledTimes(2)
})

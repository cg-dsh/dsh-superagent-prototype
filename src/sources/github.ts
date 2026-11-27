/** GitHub source kind definition, notification and repository polling loops, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { key, type Thread, type Ticket, type Trigger } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { GithubAccountsSchema } from '../deployment.ts'
import { CliError, validItems, type Tally } from '../infra/commands.ts'
import { CheckRunPageSchema, ciCounts, ciFact, ciFailures, ciSnapshot, ciSummary, checkRunPages, commitStatusPages,
  githubThreadContext, pullChecks, type CheckRunPage, type CiSnapshot } from './github-read.ts'
import { branchCiTrigger, ciTrigger, commentTrigger, CommentSchema, githubAddress, issueTrigger, IssueSchema, pullTrigger, SOURCE }
  from './github-trigger.ts'
import { githubLink, sendGithub } from './github-channel.ts'
import type { GithubComment, PullRef } from './github-trigger.ts'
import { observePull, pullRefsOf, PullSchema, pullsOf, readPull, ticketRepository, type Pull } from './github-pull.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { KV, type Key } from '../kv.ts'
import { cursorAt, eachLimit, pause, POLL_CONCURRENCY, POLL_HORIZON_MS, pollThreads as pollEach } from './poll.ts'
import { noteActivity, noteReconciliation, reconciliationDue, scheduleOf } from './github-reconcile.ts'
import { branchCiThreadId, githubThreadId, githubThreadKey, sameRepository, threadNumber, threadRepository, threadRepositoryOf } from './github-thread.ts'
import type { Localized, SourceKind } from './kind.ts'
import { z } from 'zod'

export { commentTrigger, type GithubComment } from './github-trigger.ts'
/** A notification of the agent account; `subject.url` is the API address of its Issue or PR. */
const NotificationSchema = z.looseObject({
  repository: z.looseObject({ full_name: z.string() }), subject: z.looseObject({ url: z.string().nullish() }),
})

const GithubConfigSchema = GithubAccountsSchema.extend({ pollSeconds: z.number().int().min(60).max(3600).default(60),
  /** How often the comment sweep re-reads subscribed threads; 0 does it every round. Notifications carry comments, so
   * this is a reconciliation for what they missed, and reading 126 threads every round costs more than the quota allows. */
  threadSweepSeconds: z.number().int().min(0).max(86_400).default(0),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  projectStatus: z.string().trim().max(40).default('test'),
  observeIssues: z.boolean().default(false), observePulls: z.boolean().default(false), observeComments: z.boolean().default(false),
  observeCi: z.boolean().default(false) }).strict()
export type GithubConfig = z.infer<typeof GithubConfigSchema>
const OBSERVED = { issues: 'observeIssues', pulls: 'observePulls', comments: 'observeComments', ci: 'observeCi' } as const
type Scope = keyof typeof OBSERVED
function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'pull') return 'pulls'
  return meta.kind === 'conversation' || meta.kind === 'inline' || meta.kind === 'review' ? 'comments' : undefined
}
export const githubKind: SourceKind<GithubConfig> = {
  kind: SOURCE,
  title: { zh: 'GitHub', en: 'GitHub' },
  description: { zh: '智能体的 GitHub 账号；接收仓库里发给它的通知、已订阅 Issue 与 PR 的讨论、CI 状态变化和 PR 合并关闭。', en: 'The agent\'s GitHub accounts; receives notifications to it in the repository, discussion on subscribed Issues and PRs, CI changes, and PR merge or close.' },
  schema: GithubConfigSchema,
  fields: [
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '监听的仓库', en: 'Repository' },
      hint: { zh: '写作 owner/name。这个来源接收这个仓库的通知和讨论；保存时检查智能体账号能否推送到它，然后重启 dsh-superagent。', en: 'Written owner/name. This Source receives the repository\'s notifications and discussion; saving checks that the agent account can push to it, then restarts dsh-superagent.' } },
    { key: 'repositories', type: 'lines', rows: 3, label: { zh: '同时监听的仓库', en: 'Also watch these repositories' },
      hint: { zh: '每行一个 owner/name。这里列的仓库与主仓库共用接收策略；它们的线程写作 owner/name#编号。保存时检查智能体账号能否推送到每一个，然后重启 dsh-superagent。', en: 'One owner/name per line. These repositories share the primary repository\'s Policy; their threads are named owner/name#number. Saving checks that the agent account can push to each, then restarts dsh-superagent.' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitHub CLI', en: 'Agent GitHub CLI' },
      hint: { zh: '命令名或绝对路径，通常是用 GH_CONFIG_DIR 登录智能体账号的 gh 包装脚本。智能体以它登录的账号行事，执行器以 gh 调用它。保存时检查它登录的账号能否推送到仓库，然后重启 dsh-superagent。', en: 'A command name or absolute path, usually a gh wrapper signed in to the agent account through GH_CONFIG_DIR. The agent acts as the account it is signed in to, and the Executor calls it as gh. Saving checks that this account can push to the repository, then restarts dsh-superagent.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' }, hint: { zh: 'GitHub 要求更长间隔时以 GitHub 为准。', en: 'A longer interval requested by GitHub wins.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' }, hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收仓库里的新 Issue', en: 'Receive new Issues in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 Issue 也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。', en: 'New Issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observePulls', type: 'switch', label: { zh: '接收仓库里的新 PR', en: 'Receive new pull requests in the repository' },
      hint: { zh: '打开后，没有 @ 智能体的新 PR 也会收到，由策略的接收表决定是否成为候选。', en: 'New pull requests that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收仓库里的评论', en: 'Receive comments in the repository' },
      hint: { zh: '打开后，Issue 和 PR 上没有 @ 智能体的评论和代码评论也会收到，由策略的接收表决定是否成为候选。', en: 'Comments and review comments on Issues and PRs that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeCi', type: 'switch', label: { zh: '接收默认分支的 CI', en: 'Receive the default branch\'s CI' },
      hint: { zh: '打开后，默认分支的 CI 失败和恢复会收到，由策略的接收表决定是否成为候选。', en: 'Failures of the default branch\'s CI, and its recovery, are received, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'projectStatus', type: 'text', advanced: true, label: { zh: '合并后移动到的项目状态', en: 'Project column after a merge' },
      hint: { zh: 'PR 合并后，把它的 Issue 移动到这个名称最接近的项目列；留空则不移动。按项目实际提供的列表选择，不会选择“已完成”“通过”一类的列。', en: 'After a PR merges, move its Issues to the project column whose name best matches this; empty disables it. The column is chosen from what each project offers, and a finished or passed column is never chosen.' } }],
  // What the Source observes across the repository it receives in full; elsewhere, only what addresses the agent.
  scope: ({ meta }, config) => {
    const row = scopeOf(meta)
    return { listened: true, observed: row !== undefined && config[OBSERVED[row]], ...row ? { row } : {} }
  },
  health: ['github'],
  channel: { send: sendGithub, link: githubLink },
  threadContext: githubThreadContext,
  // `#12`, `12`, or the page of an Issue or PR, of any repository, names Thread 12.
  find: query => {
    const number = (/^#?(\d+)$/.exec(query.trim()) ?? /github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)/.exec(query))?.[1]
    return { threads: number ? [`${SOURCE}:${number}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9-]+(\[bot\])?$/) }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitHub 账号', en: 'GitHub accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '评论可以成为候选的机器人', en: 'Bots whose comments may become candidates' },
      hint: { zh: '名单里的机器人账号（例如 dependabot[bot]）的评论在来源收到时成为推断的候选，交给评估：评论 @ 了智能体，或者打开了“接收仓库里的评论”。它们不能发起明确的请求，也不能停止工单；其他机器人的评论不接收。', en: 'A comment of a bot account on this list, such as dependabot[bot], becomes an inferred candidate for an assessment when the Source receives it: when it mentions the agent, or with Receive comments in the repository on. Such a comment never makes an explicit request or stops a ticket; other bots\' comments are not admitted.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9\\-]+(\\[bot\\])?' }] }],
    explicit: { zh: '名单里的账号在 Issue 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue or a comment.' },
    rows(stored) {
      const config = GithubConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issues', { zh: '新 Issue', en: 'New Issues' }), row('pulls', { zh: '新 PR', en: 'New pull requests' }),
        row('comments', { zh: '评论', en: 'Comments' }),
        // CI has no sender, so only the cell of a sender off the list who does not address the agent applies.
        { id: 'ci', label: { zh: '默认分支的 CI', en: 'Default branch CI' }, note: config.observeCi ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config.observeCi } }]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITHUB_REPOSITORY', description: { zh: '这张工单自己的线程所在的仓库，owner/name；工单不是从 GitHub 开始时是主仓库。智能体在这里开的 PR，分支最后一段是 DSH_SUPERAGENT_NAME 时（例如 agent/$DSH_SUPERAGENT_NAME）会关联到工单', en: 'The repository of the ticket\'s own thread, as owner/name; the primary repository when the ticket did not start on GitHub. A PR the agent opens here from a branch whose last path segment is DSH_SUPERAGENT_NAME (for example agent/$DSH_SUPERAGENT_NAME) binds to the ticket' } },
      { key: 'DSH_SUPERAGENT_GITHUB_ACCOUNT', description: { zh: '智能体的 GitHub 账号；gh 以它登录，除自动合并外的 GitHub 操作都用 gh，不用其他账号或凭据', en: 'The agent\'s GitHub account. gh is signed in to it; use gh for every GitHub operation except auto-merge, and never another account or credential' } },
      { key: 'DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITHUB_NUMBER', description: { zh: '接下工单的 Issue 或 PR 编号；工单不是从 GitHub 来的时为空', en: 'Number of the Issue or PR that started the ticket; empty when the ticket did not start on GitHub' } },
      { key: 'DSH_SUPERAGENT_GITHUB_PR_HEAD', description: { zh: '接下工单的 PR 的 head 引用 refs/pull/<编号>/head；不是 PR 时为空', en: 'Head ref refs/pull/<number>/head of the PR that started the ticket; empty when it was not a PR' } },
    ],
    values: ({ deployment, trigger }) => {
      const number = trigger?.threads[0]?.source === SOURCE ? Number(trigger.meta.number) || 0 : 0
      // The repository comes from the Ticket's own thread, so a Ticket that started in another repository prepares there;
      // a Ticket that did not start on GitHub uses the primary repository.
      const thread = trigger?.threads[0]
      const repository = thread?.source === SOURCE ? threadRepository(thread.id, deployment.repository) : deployment.repository
      return { DSH_SUPERAGENT_GITHUB_REPOSITORY: repository, DSH_SUPERAGENT_GITHUB_ACCOUNT: deployment.github.login, DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL: deployment.github.noreply, DSH_SUPERAGENT_GITHUB_NUMBER: number ? String(number) : '',
        DSH_SUPERAGENT_GITHUB_PR_HEAD: number && trigger?.meta.isPr === true ? `refs/pull/${number}/head` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment ? {
    cli: { zh: `当前账号 @${deployment.github.login}`, en: `Current account @${deployment.github.login}` },
  } : {},
}
export const name = 'dsh-superagent-github'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(githubKind), 'github: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, githubKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('github', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('github', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GithubConfig>(SOURCE)
    const began = Date.now()
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('github', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      // A spent quota answers every read with 403; retrying on the poll interval only deepens it, so wait it out.
      if (rateLimited(error)) {
        if (!signal.aborted) ctx.report('github', health('paused', 'rateLimited'))
        failures = 0
        await pause(RATE_LIMIT_BACKOFF_MS, signal)
        continue
      }
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('github', failed)
    }
    // A round that already outlasted the interval has waited long enough: the cadence is the round, not the round plus a pause.
    const wait = Math.max(interval, ctx.config<GithubConfig>(SOURCE)?.pollSeconds ?? 60) * 1000 - (Date.now() - began)
    await pause(Math.max(wait, 0), signal)
  }
}
interface Round {
  started: string; signal?: AbortSignal | undefined
  /** Pull requests read in this round, by thread id, so a number in one repository is not another's. */
  pulls: Map<string, Promise<Pull>>
  /** CI fingerprints read in this round, by thread id, so two Tickets following one pull request read its checks once. */
  checks: Map<string, Promise<string>>
  read: Set<string>; failures: string[]; dropped: string[]; abandoned: string[]
  /** Tickets this round owes a reconciliation, frozen before its reads so activity found later adds none to this round. */
  due?: Set<string>
  /** What this round's reconciliation reads observed for each Ticket, by ticket id, written once the round finishes. */
  observed: Map<string, { pulls: string[]; issue: string[] }>
  /** Tickets whose reconciliation read failed, so their schedule does not advance and the next round retries them. */
  retry: Set<string>
  tally: Tally
}
/** How many Ticket changes one round reads from the local change feed, which costs no GitHub call. */
const TICKET_CHANGES_PER_ROUND = 200
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, pulls: new Map(), checks: new Map(),
  read: new Set(), observed: new Map(), retry: new Set(), failures: [], dropped: [], abandoned: [], tally: { skipped: 0 } })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
/** The primary repository, whose thread ids stay bare and whose keys keep their old form. */
const primaryOf = (ctx: SourceContext): string => ctx.deployment.repository
/** The thread id of Issue or PR `number` in the repository this context reads. */
const threadIdOf = (ctx: SourceContext, number: number): string => githubThreadId(ctx.repository, number, primaryOf(ctx))
/** The thread id a Thread or a stored id names, normalising the bare form to the primary repository. */
const refThreadId = (ctx: SourceContext, id: string): string =>
  githubThreadId(threadRepository(id, primaryOf(ctx)), threadNumber(id), primaryOf(ctx))
/** The prefix that keeps another repository's KV records apart; the primary repository's keys stay exactly as they were. */
const repoKey = (ctx: SourceContext): string => sameRepository(ctx.repository, primaryOf(ctx)) ? '' : `${ctx.repository}:`
/** The repository a stored thread ref names, including a default-branch CI thread (`ci:` or `ci:owner/name#branch`). */
const threadRefRepository = (ctx: SourceContext, id: string): string => threadRepositoryOf(id, primaryOf(ctx))
/** The normalised thread id of a stored ref; a CI thread already carries the form it keeps. */
const threadRefId = (ctx: SourceContext, id: string): string => id.startsWith('ci:') ? id : refThreadId(ctx, id)
/** Where a failure happened, so two repositories' streams are told apart; empty for the primary repository. */
const where = (ctx: SourceContext): string => sameRepository(ctx.repository, primaryOf(ctx)) ? '' : `${ctx.repository}: `
/** A GitHub resource's conditional read record: the body it last returned and the validator GitHub gave for it. */
type ConditionalRecord = { value: unknown; etag?: string; lastModified?: string }
/** What a conditional read keeps between rounds: the body and the validator that describes it. */
interface Kept<T> { value: T; etag?: string; lastModified?: string }
/** The body and validator a conditional read kept, when present and still validating; otherwise undefined, so the read is a full one. */
function kept<T>(ctx: SourceContext, key: Key<ConditionalRecord>, schema: z.ZodType<T>): Kept<T> | undefined {
  const stored = ctx.state.get(key)
  if (!stored || typeof stored !== 'object') return undefined
  const parsed = schema.safeParse(stored.value)
  return parsed.success ? { value: parsed.data, ...stored.etag ? { etag: stored.etag } : {},
    ...stored.lastModified ? { lastModified: stored.lastModified } : {} } : undefined
}
/** Keeps what a 200 returned, so the next round sends its ETag and an unchanged resource answers 304. */
function keep<T>(ctx: SourceContext, key: Key<ConditionalRecord>, answer: { value: T; etag?: string; lastModified?: string }): void {
  ctx.state.set(key, { value: answer.value, ...answer.etag ? { etag: answer.etag } : {},
    ...answer.lastModified ? { lastModified: answer.lastModified } : {} })
}
/** The Tickets this round owes a reconciliation: the frozen due set, or the ladder when a step is called on its own. */
function dueTickets(ctx: SourceContext, round: Round): Ticket[] {
  const now = Date.parse(round.started)
  return ctx.tickets.open().filter(ticket => round.due
    ? round.due.has(ticket.id)
    : reconciliationDue(scheduleOf(ctx, ticket.id), now))
}
/** What this round's reconciliation reads observed for a Ticket, created on its first successful read. */
function observed(round: Round, ticketId: string): { pulls: string[]; issue: string[] } {
  let seen = round.observed.get(ticketId)
  if (!seen) { seen = { pulls: [], issue: [] }; round.observed.set(ticketId, seen) }
  return seen
}
/**
 * Marks the Tickets the local change feed reports as active, which resets their ladder to the top bucket, and freezes what
 * this round owes. The feed costs no GitHub read, and freezing before the round's reads keeps activity found later from
 * adding a read of its own to this round.
 */
function planReconciliations(ctx: SourceContext, round: Round): void {
  const cursor = ctx.state.get(KV.github.changes)
  // The first round starts the feed now: Tickets already open have no schedule and are reconciled as first sightings.
  if (!cursor) ctx.state.set(KV.github.changes, { at: round.started, id: '' })
  else {
    const changes = ctx.tickets.changed(cursor, TICKET_CHANGES_PER_ROUND)
    ctx.state.set(KV.github.changes, changes.next)
    // A changed Ticket is reconciled this round, which is what a Ticket someone is waiting on needs; others follow the ladder.
    for (const { ticket } of changes.items) noteActivity(ctx, ticket.id, round.started)
  }
  const now = Date.parse(round.started)
  round.due = new Set(ctx.tickets.open().filter(ticket => reconciliationDue(scheduleOf(ctx, ticket.id), now)).map(ticket => ticket.id))
}
/** Writes what the round's reconciliation reads observed, unless a read failed: a failed Ticket stays due for the next round. */
function settleReconciliations(ctx: SourceContext, round: Round): void {
  if (stopped(ctx, round)) return
  for (const [ticketId, seen] of round.observed) {
    if (round.retry.has(ticketId)) continue
    noteReconciliation(ctx, ticketId, { pulls: JSON.stringify([...seen.pulls].sort()), issue: JSON.stringify([...seen.issue].sort()) }, round.started)
  }
}
export interface Retry { since: string; pr: boolean; failedAt?: string; attempts?: number }
/** Slack added to every notified read:
 * GitHub indexes a notification seconds to a minute after the comment it is for,
 * so reading strictly from the polling cursor drops a comment created just before
 * it. The window re-reads that few minutes; Trigger ids make a repeated read harmless. */
const NOTIFICATION_LAG_MS = 10 * 60 * 1000
const RETRY_WINDOW_MS = 24 * 3600_000
/** How long a spent GitHub quota is left alone: the window is hourly, so ten quiet minutes clear a burst. */
const RATE_LIMIT_BACKOFF_MS = 10 * 60_000
/** True when GitHub refused the read because the hourly quota is spent. */
function rateLimited(error: unknown): boolean {
  return error instanceof CliError && error.code === 403 && /rate limit/i.test(error.message)
}
/** True when GitHub returns HTTP 410 (Gone); HTTP 404 is retried because it can indicate revoked access to a private repository. */
const deleted = (error: unknown): boolean => error instanceof CliError && error.code === 410
/** Records a failed read on the Thread and in the round; deleted (410) or abandoned (24h+) threads do not fail the round. */
function failed(ctx: SourceContext, round: Round, thread: string, error: unknown, abandoned = false): void {
  const id = refThreadId(ctx, thread)
  if (deleted(error)) round.dropped.push(id)
  else if (abandoned) round.abandoned.push(id)
  else round.failures.push(`#${id}: ${String(error)}`)
  ctx.threads.patch(`github:${id}`, { pollError: String(error) })
}
function included(raw: string): { headers: string; body: string } {
  const split = raw.search(/\r?\n\r?\n/)
  if (split < 0) throw new Error('GitHub returned no HTTP headers')
  return { headers: raw.slice(0, split), body: raw.slice(split).trim() }
}
const ListedSchema = CommentSchema.extend({ issue_url: z.string().nullish(), pull_request_url: z.string().nullish() })
/** Repository-wide event streams; GitHub's `/issues` endpoint includes PRs, and `/issues/comments` covers issue and PR conversation comments (excluding inline review comments). */
const STREAMS = [
  { id: 'issues', observed: (config: GithubConfig) => config.observeIssues || config.observePulls, path: 'issues?state=all' },
  { id: 'comments', observed: (config: GithubConfig) => config.observeComments, path: 'issues/comments?' },
  { id: 'review-comments', observed: (config: GithubConfig) => config.observeComments, path: 'pulls/comments?' },
] as const
/** Polls repository-wide streams (new Issues/PRs, comments, default-branch CI); each stream reads from when it was switched on, resets when switched off, and fails independently. */
async function pollRepository(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GithubConfig>(SOURCE)
  if (!config) return
  const repository = primaryOf(ctx)
  for (const stream of STREAMS) {
    if (stopped(ctx, round)) return
    if (!stream.observed(config)) { ctx.state.set(KV.github.stream(`${repoKey(ctx)}${stream.id}`), undefined); continue }
    try { await readStream(ctx, round, stream.id, stream.path, config) }
    catch (error) { if (!stopped(ctx, round)) round.failures.push(`${where(ctx)}${stream.id}: ${String(error)}`) }
  }
  // When CI observation is turned off, clear the failure baseline but preserve the revision counter so future triggers have unique IDs.
  if (!config.observeCi) {
    const seen = ctx.state.get(KV.github.branchCi(ctx.repository, repository))
    ctx.state.set(KV.github.branchCi(ctx.repository, repository), seen && { revision: seen.revision })
    return
  }
  try { await pollBranchCi(ctx, round) }
  catch (error) { if (!stopped(ctx, round)) round.failures.push(`${where(ctx)}default branch CI: ${String(error)}`) }
}
/**
 * Polls one repository-wide event stream (oldest first) since its cursor and steps the cursor to five seconds before the
 * newest item (`cursorAt`), relying on Trigger ID deduplication so repeated messages are no-ops. While the cursor stays
 * unchanged (including when clamped to the hourly horizon), sending the last page's ETag makes an unchanged list return
 * HTTP 304 and cost no rate limit. Items from before their kind was switched on or beyond the horizon are ignored.
 */
async function readStream(ctx: SourceContext, round: Round, id: string, path: string, config: GithubConfig): Promise<void> {
  const name = KV.github.stream(`${repoKey(ctx)}${id}`)
  const stored = ctx.state.get(name)
  const kinds = id === 'issues' ? [...config.observeIssues ? ['issues'] : [], ...config.observePulls ? ['pulls'] : []] : ['comments']
  const before = typeof stored?.started === 'object' ? stored.started : {}
  const started: Record<string, string> = Object.fromEntries(kinds.map(kind => [kind, before[kind] ?? round.started]))
  const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3_600_000) * 3_600_000
  const since = new Date(Math.max(Date.parse(stored?.since ?? round.started), horizon)).toISOString()
  const conditional = stored?.etag && stored.since === since ? ['-H', `If-None-Match: ${stored.etag}`] : []
  let raw: string
  const listed = `${path}&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`
  try { raw = await ctx.commands.withSignal(round.signal).api(listed, '--include', ...conditional) }
  catch (error) {
    if (error instanceof CliError && error.code === 304) return
    throw error
  }
  const { headers, body } = included(raw)
  const items = validItems(ListedSchema, z.array(z.unknown()).parse(JSON.parse(body)), round.tally)
  const { login } = ctx.deployment.github
  const fresh = (at: string | null | undefined, kind: string) =>
    kind in started && Date.parse(at ?? '') >= Math.max(Date.parse(started[kind]!), horizon)
  for (const item of items) {
    // Stopping mid-stream aborts before advancing the cursor so unread items are retried.
    if (stopped(ctx, round)) throw new Error('The GitHub Source stopped during the poll')
    if (sameName(item.user.login, login)) continue
    if (id === 'issues') {
      const issue = IssueSchema.safeParse(item)
      const pr = issue.success && !!issue.data.pull_request
      if (!issue.success || !fresh(issue.data.created_at, pr ? 'pulls' : 'issues')) continue
      const thread = threadIdOf(ctx, issue.data.number)
      await ctx.receive(pr ? pullTrigger(issue.data, login, thread) : issueTrigger(issue.data, login, thread))
      nameThread(ctx, issue.data.number, issue.data.title)
      continue
    }
    const number = Number(/\/(?:issues|pulls)\/(\d+)$/.exec((id === 'comments' ? item.issue_url : item.pull_request_url) ?? '')?.[1])
    if (!number || !fresh(item.updated_at ?? item.created_at, 'comments')) continue
    const isPr = id === 'review-comments' || /\/pull\//.test(item.html_url ?? '')
    const ref = { number, isPr, thread: threadIdOf(ctx, number), ...item.html_url ? { url: item.html_url } : {} }
    const trigger = commentTrigger(item, ref, id === 'comments' ? 'conversation' : 'inline', login)
    if (trigger.text) await ctx.receive(trigger)
  }
  const newest = Math.max(...items.map(item => Date.parse(item.updated_at ?? '')).filter(Number.isFinite))
  const moved = Number.isFinite(newest) ? cursorAt(new Date(newest).toISOString()) : since
  const next = Date.parse(moved) > Date.parse(since) ? moved : since
  const etag = /^etag:\s*(.+)$/im.exec(headers)?.[1]?.trim()
  // The ETag belongs to this request, which the next round repeats only while the cursor stays unchanged.
  ctx.state.set(name, { since: next, started, ...etag && next === since ? { etag } : {} })
}
/** Polls default-branch CI checks, emitting a trigger only when the set of failing checks changes after the initial baseline. */
async function pollBranchCi(ctx: SourceContext, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const repository = primaryOf(ctx)
  const { default_branch: branch } = await commands.api(z.looseObject({ default_branch: z.string() }), '')
  const thread = branchCiThreadId(branch, ctx.repository, repository)
  const head = await commands.api(z.looseObject({ sha: z.string() }), `commits/${encodeURIComponent(branch)}`)
  const snapshot = await pullChecks(commands, head.sha, round.tally)
  const previous = ctx.state.get(KV.github.branchCi(ctx.repository, repository))
  // The first observation after switching on or renaming the default branch establishes the baseline.
  const known = previous?.branch === branch ? previous.failures : undefined
  const failures = ciFailures(snapshot)
  const counts = ciCounts(snapshot)
  // Retain previous failures while checks are still running so recovery is reported only once all checks pass.
  const now = failures.length || !counts.running ? failures : known ?? []
  let revision = previous?.revision ?? 0
  if (known && JSON.stringify(now) !== JSON.stringify(known)) {
    revision += 1
    const summary = ciSummary(snapshot, branch, `github/commits/${head.sha}/checks`)
    const url = `https://github.com/${ctx.repository}/commit/${head.sha}`
    await ctx.receive(branchCiTrigger(branch, head.sha, revision, summary, url, thread))
    ctx.threads.describe(`github:${thread}`, { label: `CI on ${branch}`, facts: { ci: ciFact(counts) } })
  }
  ctx.state.set(KV.github.branchCi(ctx.repository, repository), { branch, failures: now, revision })
}
/**
 * One polling round: notifications, then observed repository streams, then the PRs of open tickets with their CI, then
 * subscribed Threads. Each step and each Issue, PR, or Thread fails independently so all steps run before the round fails.
 * Other read failures (including 404) fail the round toward the error threshold, whereas deleted (410) or abandoned
 * (24h+) threads are recorded only on the thread and in health detail.
 * @returns the polling interval requested by GitHub, in seconds.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  // The local change feed and the ladder decide what this round owes each Ticket before any GitHub read of it.
  planReconciliations(ctx, round)
  const began = Date.now()
  // Where a round spends its time decides the detection latency, so each step is timed and reported.
  let mark = Date.now()
  const spent: string[] = []
  const lap = (name: string) => { const now = Date.now(); spent.push(`${name} ${((now - mark) / 1000).toFixed(1)}s`); mark = now }
  const notified = await pollNotifications(ctx, round).then(value => ({ value }), (error: unknown) => ({ error }))
  lap('notify')
  // One context per watched repository: each repository's reads and records go through its own scope, in one round.
  const repositories = ctx.deployment.repositories.length ? ctx.deployment.repositories : [ctx.deployment.repository]
  const scopes = repositories.map(repository => ctx.scope?.(repository) ?? ctx)
  for (const scoped of scopes) await pollRepository(scoped, round)
  lap('streams')
  for (const scoped of scopes) await pollTicketPulls(scoped, signal, round)
  lap('pulls')
  for (const scoped of scopes) await pollRequesterClosed(scoped, round)
  lap('closed')
  settleReconciliations(ctx, round)
  for (const scoped of scopes) await pollThreads(scoped, signal, round)
  lap('threads')
  if ('error' in notified) throw notified.error
  const { count, interval } = notified.value
  if (signal?.aborted) return interval
  if (round.failures.length) throw new Error(`${round.failures.length} GitHub reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  // A bare id is the primary repository's; a qualified one names its own repository already.
  const named = (threads: string[]) => [...new Set(threads)]
    .sort((a, b) => a.includes('#') || b.includes('#') ? a.localeCompare(b) : Number(a) - Number(b))
    .map(thread => thread.includes('#') ? thread : `#${thread}`).join(', ')
  const dropped = (round.dropped.length ? `; deleted on GitHub: ${named(round.dropped)}` : '')
    + (round.abandoned.length ? `; dropped after their reads kept failing: ${named(round.abandoned)}` : '')
    + (round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : '')
  // The health text stays stable for its readers; where a round spends its time goes to the log that diagnoses latency.
  console.info(`github poll round: ${((Date.now() - began) / 1000).toFixed(1)}s (${spent.join(', ')})`)
  ctx.report('github', { state: 'ready', detail: `${count} notifications; next poll ≥ ${interval}s${dropped}`, at: round.started })
  return interval
}
/** Reads notifications since the cursor and each Issue or PR they name, advancing the cursor atomically with the retry map for failed reads; deleted (410) Issues are dropped once their error is recorded. */
async function pollNotifications(ctx: SourceContext, round: Round): Promise<{ count: number; interval: number }> {
  const { state } = ctx
  const commands = ctx.commands.withSignal(round.signal)
  const since = state.get(KV.github.since) ?? round.started
  if (state.get(KV.github.since) === undefined) state.set(KV.github.since, since)
  const repository = primaryOf(ctx)
  const watched = ctx.deployment.repositories.length ? ctx.deployment.repositories : [repository]
  // The notifications endpoint is the account's, not a repository's: it is read once per round and dispatched below.
  const path = `notifications?all=true&per_page=50&since=${encodeURIComponent(since)}`
  const raw = await commands.account(path, '--include')
  const split = raw.search(/\r?\n\r?\n/)
  if (split < 0) throw new Error('GitHub returned no HTTP headers')
  const headers = raw.slice(0, split)
  const body = raw.slice(split).trim()
  const asked = Number(/x-poll-interval:\s*(\d+)/i.exec(headers)?.[1] ?? 60)
  const interval = Math.max(60, Number.isFinite(asked) ? asked : 60)
  const notifications = /rel="next"/.test(headers)
    ? await commands.accountPages(NotificationSchema, path, round.tally)
    : validItems(NotificationSchema, z.array(z.unknown()).parse(JSON.parse(body)), round.tally)
  const retries = { ...state.get(KV.github.retries) }
  // Failed items from the previous round run first, followed by newly notified items in chronological order; each is read once.
  // They are keyed by thread id, so #12 in one repository and #12 in another are two reads with two read positions.
  const items = new Map<string, Retry>(Object.entries(retries))
  for (const notification of notifications.reverse()) {
    // A notification names its repository; one the Source does not watch (an account may act elsewhere) is skipped.
    const scope = watched.find(name => sameRepository(name, notification.repository.full_name))
    if (!scope) continue
    const address = githubAddress(notification.subject.url ?? '', scope)
    if (!address || address.discussion) continue
    const thread = githubThreadId(scope, address.number, repository)
    if (items.has(thread)) continue
    const { number, pr } = address
    items.set(thread, { since: [state.get(KV.github.cursor(thread)) ?? since, since].sort().at(-1)!, pr })
  }
  for (const [thread, item] of items) {
    if (stopped(ctx, round)) return { count: notifications.length, interval }
    round.read.add(thread)
    // Everything a notification makes the Source read is repository-scoped, so it runs in its repository's context.
    const scoped = ctx.scope?.(threadRepository(thread, repository)) ?? ctx
    try {
      await readNotified(scoped, round, threadNumber(thread), item)
      delete retries[thread]
    } catch (error) {
      if (stopped(ctx, round)) return { count: notifications.length, interval }
      const retry = { ...item, failedAt: item.failedAt ?? round.started, attempts: (item.attempts ?? 0) + 1 }
      // Abandon notification retries after 24 hours of failures so a permanently unreadable thread does not hold source health in error; its cursor stays so a later notification or thread poll still reads what was missed.
      const abandoned = Date.parse(round.started) - Date.parse(retry.failedAt) >= RETRY_WINDOW_MS
      failed(scoped, round, thread, error, abandoned)
      if (!deleted(error) && !abandoned) { retries[thread] = retry; continue }
      delete retries[thread]
    }
  }
  ctx.atomic(() => { state.set(KV.github.since, cursorAt(round.started)); state.set(KV.github.retries, retries) })
  return { count: notifications.length, interval }
}
async function readNotified(ctx: SourceContext, round: Round, number: number, item: Retry): Promise<void> {
  const { since } = item
  const thread = threadIdOf(ctx, number)
  let isPr = item.pr
  if (!isPr) {
    const issue = await ctx.commands.withSignal(round.signal).api(IssueSchema, `issues/${number}`)
    // `issues/<n>` also returns PRs with `pull_request` set; handle them in the PR branch below.
    isPr = !!issue.pull_request
    if (!isPr) {
      // An Issue opened by someone other than the agent since the cursor brings its body so a mention in it reaches the gate.
      // A mention added by a later edit to the body is not read: only the author can be the actor of the body.
      const { login } = ctx.deployment.github
      const opened = Date.parse(issue.created_at) >= Date.parse(since) && !sameName(issue.user.login, login)
      if (opened) await ctx.receive(issueTrigger(issue, login, thread))
      await intakeComments(ctx, { number, isPr: false, url: issue.html_url, thread }, since, round)
      nameThread(ctx, number, issue.title)
    }
  }
  if (isPr) {
    const pr = await pull(ctx, round, number)
    // Emit a PR description trigger for PRs opened since the cursor; its ID is the same as the one produced by the repository PR stream.
    const { login } = ctx.deployment.github
    if (pr.created_at && Date.parse(pr.created_at) >= Date.parse(since) && !sameName(pr.user.login, login)) {
      const opened = { number, title: pr.title ?? '', body: pr.body, user: pr.user, created_at: pr.created_at, html_url: pr.html_url }
      await ctx.receive(pullTrigger(opened, login, thread))
    }
    await intakeComments(ctx, { number, isPr: true, url: pr.html_url, prAuthor: pr.user.login, thread }, since, round)
    if (pr.title) nameThread(ctx, number, pr.title)
  }
  ctx.state.set(KV.github.cursor(thread), cursorAt(round.started))
  ctx.threads.patch(githubThreadKey(ctx.repository, number, primaryOf(ctx)), { pollError: undefined })
}
/** Reads a round's pull request conditionally: an unchanged PR answers 304 and its kept body is used, so it costs no rate limit. */
async function readPullForPoll(ctx: SourceContext, round: Round, number: number): Promise<Pull> {
  const key = KV.github.conditional('pull', threadIdOf(ctx, number))
  const prior = kept(ctx, key, PullSchema)
  const answer = await ctx.commands.withSignal(round.signal).apiConditional(PullSchema, `pulls/${number}`, prior)
  if (answer.notModified) return prior ? { ...prior.value, number } : readPull(ctx, number, round.signal)
  keep(ctx, key, answer)
  return { ...answer.value, number }
}
/** Reads and observes a PR at most once per polling round. */
function pull(ctx: SourceContext, round: Round, number: number): Promise<Pull> {
  const thread = threadIdOf(ctx, number)
  let read = round.pulls.get(thread)
  if (!read) {
    read = readPullForPoll(ctx, round, number).then(async pr => { await observePull(ctx, pr); return pr })
    round.pulls.set(thread, read)
  }
  return read
}
async function intakeComments(ctx: SourceContext, ref: PullRef, since: string, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  // Read from before the cursor: a notification can arrive after the comment it announces.
  const from = new Date(Date.parse(since) - NOTIFICATION_LAG_MS).toISOString()
  const { login } = ctx.deployment.github
  const kinds = ref.isPr ? ['conversation', 'inline', 'review'] as const : ['conversation'] as const
  for (const kind of kinds) {
    const suffix = `&since=${encodeURIComponent(from)}`
    const path = kind === 'conversation' ? `issues/${ref.number}/comments?per_page=100${suffix}` : kind === 'inline' ? `pulls/${ref.number}/comments?per_page=100${suffix}` : `pulls/${ref.number}/reviews?per_page=100`
    const comments = await commands.pages(CommentSchema, path, round.tally)
    for (const comment of comments) {
      // Stopping mid-read throws so the thread's cursor stays where it was.
      if (stopped(ctx, round)) throw new Error('The GitHub Source stopped during the poll')
      const timestamp = Date.parse(comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? '')
      if (!Number.isFinite(timestamp) || timestamp < Date.parse(from)) continue
      if (sameName(comment.user.login, login)) continue
      // A review decision without a body still reaches the ticket: a worker may be waiting for that approval.
      const trigger = commentTrigger(comment, ref, kind, login)
      if (trigger.text) await ctx.receive(trigger)
    }
  }
}
/** Reads the Issue that can withdraw a Ticket conditionally: an unchanged Issue answers 304 and its kept state is used. */
async function readIssueForPoll(ctx: SourceContext, round: Round, number: number): Promise<z.infer<typeof IssueSchema>> {
  const key = KV.github.conditional('issue', threadIdOf(ctx, number))
  const prior = kept(ctx, key, IssueSchema)
  const answer = await ctx.commands.withSignal(round.signal).apiConditional(IssueSchema, `issues/${number}`, prior)
  if (answer.notModified) return prior ? prior.value : ctx.commands.withSignal(round.signal).api(IssueSchema, `issues/${number}`)
  keep(ctx, key, answer)
  return answer.value
}
/**
 * Notices that a person closed the Issue that started an open Ticket. A withdrawn request ends the Ticket rather than
 * leaving it waiting on a question nobody will answer. A Ticket whose own PR is still open is the exception: the work
 * exists, so its Executor is asked to reopen the Issue and settle the PR instead of the Ticket ending silently.
 */
async function pollRequesterClosed(ctx: SourceContext, round: Round): Promise<void> {
  const repository = primaryOf(ctx)
  const tickets = dueTickets(ctx, round).filter(ticket => sameRepository(ticketRepository(ticket, repository), ctx.repository))
  await eachLimit(tickets, POLL_CONCURRENCY, async ticket => {
    if (stopped(ctx, round)) return
    for (const channel of ticket.channels ?? []) {
      if (channel.source !== SOURCE) continue
      // The channel's thread names the repository; another repository's Ticket is settled by its own scoped step.
      const channelThread = channel.thread.slice(SOURCE.length + 1)
      if (!sameRepository(threadRepository(channelThread, repository), ctx.repository)) continue
      const number = threadNumber(channelThread)
      if (!Number.isFinite(number) || number <= 0) continue
      // A PR thread is settled by `pollTicketPulls`; only the Issue that started the Ticket can be withdrawn.
      if ((channel.address.url ?? '').includes('/pull/')) continue
      let issue: z.infer<typeof IssueSchema>
      try {
        issue = await readIssueForPoll(ctx, round, number)
      } catch (error) {
        round.retry.add(ticket.id)
        if (!stopped(ctx, round)) failed(ctx, round, channelThread, error)
        continue
      }
      const closedAt = (issue as { closed_at?: string | null }).closed_at
      observed(round, ticket.id).issue.push(`issue:${threadIdOf(ctx, number)}:${issue.state}:${closedAt ?? ''}`)
      if (issue.state !== 'closed') continue
      const at = closedAt ?? new Date().toISOString()
      if (ctx.state.get(KV.github.requesterClosed(ticket.id)) === at) continue
      ctx.state.set(KV.github.requesterClosed(ticket.id), at)
      const open = pullsOf(ticket, true)
      const thread = threadIdOf(ctx, number)
      if (open.length) await ctx.receive(closedIssueTrigger(issue, number, open, thread))
      else ctx.tickets.requesterClosed(ticket.id, at)
    }
  })
}
/** The Trigger that tells an Executor its Issue was closed while its PR is still open. */
function closedIssueTrigger(issue: z.infer<typeof IssueSchema>, number: number, open: readonly number[],
  threadId: string): Trigger {
  const at = (issue as { closed_at?: string | null }).closed_at ?? new Date().toISOString()
  const list = open.map(item => `#${item}`).join(', ')
  return { id: key('github-issue-closed', String(number), at), source: SOURCE,
    threads: [{ source: SOURCE, id: threadId }], actor: { source: SOURCE, id: issue.user?.login ?? '' },
    human: true, at, url: issue.html_url,
    text: `Issue #${number} was closed while PR ${list} is still open. Reopen the Issue with one line saying why, and ask for the PR to be merged or closed; never leave it dangling.`,
    channel: { source: SOURCE, thread: `github:${threadId}`, address: { number: String(number), url: issue.html_url } },
    meta: { number, isPr: false, kind: 'issue' } }
}

export async function pollTicketPulls(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  // Each follow thread names its repository; this scoped step reads only the pull requests of its own.
  const repository = primaryOf(ctx)
  const work = dueTickets(ctx, round).flatMap(ticket => pullRefsOf(ticket, repository, true)
    .filter(ref => sameRepository(ref.repository, ctx.repository))
    .map(ref => ({ ticket, thread: threadIdOf(ctx, ref.number), number: ref.number })))
  // A pull request several Tickets follow is read once; each Ticket still records what it saw.
  const numbers = new Map(work.map(item => [item.thread, item.number]))
  const seen = new Map<string, string>()
  await eachLimit([...numbers.values()], POLL_CONCURRENCY, async number => {
    if (stopped(ctx, round)) return
    const thread = threadIdOf(ctx, number)
    try {
      const pr = await pull(ctx, round, number)
      const checks = pr.state !== 'closed' && !pr.merged ? await pullChecksOnce(ctx, round, number, pr) : ''
      seen.set(thread, `pr:${thread}:${pr.state}:${pr.merged ? 'merged' : 'open'}:${pr.head.sha}:${checks}`)
    } catch (error) {
      if (!stopped(ctx, round)) failed(ctx, round, thread, error)
      seen.set(thread, '')
    }
  })
  for (const item of work) {
    const observation = seen.get(item.thread)
    // A pull request this round could not read keeps its Ticket due, so the next round retries it rather than waiting out the ladder.
    if (!observation) round.retry.add(item.ticket.id)
    else observed(round, item.ticket.id).pulls.push(observation)
  }
}
/** One page of a GitHub list read conditionally; a list with a next page is read in full and not kept, because an ETag describes only the page it came from. */
async function polledPages<T>(ctx: SourceContext, round: Round, resource: string, thread: string, path: string,
  schema: z.ZodType<T>, full: () => Promise<T[]>): Promise<T[]> {
  const key = KV.github.conditional(resource, thread)
  const prior = kept(ctx, key, schema)
  const answer = await ctx.commands.withSignal(round.signal).apiConditional(schema, path, prior)
  if (answer.notModified) return prior ? [prior.value] : full()
  if (answer.more) { ctx.state.set(key, undefined); return full() }
  keep(ctx, key, answer)
  return [answer.value]
}
/** A PR's CI as this round read it: both of its list reads are conditional, so unchanged checks cost no rate limit. */
async function pullChecksForPoll(ctx: SourceContext, round: Round, thread: string, head: string): Promise<CiSnapshot> {
  const commands = ctx.commands.withSignal(round.signal)
  const pages = await polledPages<CheckRunPage>(ctx, round, 'check-runs', thread, `commits/${head}/check-runs?per_page=100`,
    CheckRunPageSchema, () => checkRunPages(commands, head))
  const statuses = await polledPages<unknown[]>(ctx, round, 'statuses', thread, `commits/${head}/statuses?per_page=100`,
    z.array(z.unknown()), () => commitStatusPages(commands, head))
  return ciSnapshot(head, pages.flatMap(page => page.check_runs), statuses.flat(), round.tally)
}
/** Polls a PR's CI checks at most once per round, however many Tickets follow that pull request. */
function pullChecksOnce(ctx: SourceContext, round: Round, number: number, pr: Pull): Promise<string> {
  const thread = threadIdOf(ctx, number)
  let read = round.checks.get(thread)
  if (!read) { read = pollChecks(ctx, round, number, pr); round.checks.set(thread, read) }
  return read
}
/** Reads a PR's CI checks and answers their fingerprint; a change after the first look is a Trigger. */
async function pollChecks(ctx: SourceContext, round: Round, number: number, pr: Pull): Promise<string> {
  const thread = threadIdOf(ctx, number)
  const snapshot = await pullChecksForPoll(ctx, round, thread, pr.head.sha)
  const fingerprint = key(JSON.stringify(snapshot))
  const previous = ctx.state.get(KV.github.ci(thread))
  if (previous?.fingerprint === fingerprint) return fingerprint
  const revision = previous ? previous.revision + 1 : 0
  if (previous) await ctx.receive(ciTrigger(pr, revision, ciSummary(snapshot, `PR #${number}`, `github/pulls/${number}/checks`), thread))
  ctx.state.set(KV.github.ci(thread), { fingerprint, revision })
  ctx.threads.describe(githubThreadKey(ctx.repository, number, primaryOf(ctx)), { facts: { ci: ciFact(ciCounts(snapshot)) } })
  return fingerprint
}
function nameThread(ctx: SourceContext, number: number, title: string): void {
  const thread = githubThreadKey(ctx.repository, number, primaryOf(ctx))
  ctx.threads.patch(thread, { title })
  ctx.threads.describe(thread, { label: `#${number} ${title}`, facts: { number: { value: `#${number}` } } })
}
/** Polls subscribed Issue and PR Threads not already read in this round; a deleted (410) Issue is still polled within the horizon (costing one read) and does not fail the round. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  // Comments arrive as notifications; re-reading every subscribed thread each round costs about 380 reads, more than the
  // hourly quota allows. A configured interval turns this into a reconciliation for whatever the notifications missed.
  const sweepSeconds = ctx.config<GithubConfig>(SOURCE)?.threadSweepSeconds ?? 0
  const repository = primaryOf(ctx)
  if (sweepSeconds > 0) {
    const name = KV.github.threadSweep(ctx.repository, repository)
    const last = ctx.state.get(name)
    if (last && Date.now() - Date.parse(last) < sweepSeconds * 1000) return
    ctx.state.set(name, round.started)
  }
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      if (deleted(error)) round.dropped.push(threadRefId(ctx, thread.ref.id)); else round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => !sameRepository(threadRefRepository(ctx, thread.ref.id), ctx.repository) || round.read.has(threadRefId(ctx, thread.ref.id)))
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  // The default branch's CI Thread has no Issue or PR to read; its CI arrives as Triggers.
  if (thread.ref.id.startsWith('ci:')) return
  const number = threadNumber(thread.ref.id)
  if (!number) throw new Error('Subscribed thread has no GitHub issue or PR number')
  const id = threadRefId(ctx, thread.ref.id)
  round.read.add(id)
  if (typeof thread.meta.isPr !== 'boolean' || typeof thread.meta.title !== 'string') {
    const issue = await ctx.commands.withSignal(round.signal).api(IssueSchema, `issues/${number}`)
    ctx.threads.patch(thread.key, { number, isPr: !!issue.pull_request, url: issue.html_url })
    if (issue.title) nameThread(ctx, number, issue.title)
    thread = ctx.threads.get(thread.key) ?? thread
  }
  const checkpoint = KV.github.cursor(id)
  const since = ctx.state.get(checkpoint) ?? thread.createdAt
  if (thread.meta.isPr === true) {
    const pr = await pull(ctx, round, number)
    await intakeComments(ctx, { number, isPr: true, url: pr.html_url, prAuthor: pr.user.login, thread: id }, since, round)
  } else await intakeComments(ctx, { number, isPr: false, thread: id }, since, round)
  ctx.state.set(checkpoint, cursorAt(round.started))
}

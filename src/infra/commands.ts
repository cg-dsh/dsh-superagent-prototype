/** Subprocess wrapper for running gh, lark-cli, and git commands under the deployment's configured accounts. */
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Deployment } from '../deployment.ts'

const exec = promisify(execFile)
const TIMEOUT_MS = 90_000
/**
 * Error thrown by Commands when a CLI invocation fails, capturing stderr diagnostics, API error codes, and exit status without echoing command arguments.
 * Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
 */
export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number, readonly output?: string) { super(message) }
}
/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
export function commandError(error: unknown, program = 'command'): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const exitCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
  // `gh` prints a response's status line and headers before it exits non-zero for one it treats as an error, such as
  // HTTP 304 or 403, so the output is kept with the failure: a conditional read takes its status from there.
  const output = error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' && error.stdout
    ? error.stdout : undefined
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: number; message?: string } } | undefined
    try { parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed }
    catch { /* Non-JSON CLI diagnostics are retained below. */ }
    const code = parsed?.error?.code
    if (parsed?.error?.message) return new CliError(`${parsed.error.message}${code ? ` (${code})` : ''}`, code, exitCode, output)
    // `gh` exits non-zero on HTTP errors (such as `gh: Not Found (HTTP 404)`) and on `gh: HTTP 304`, which ETag polling relies on.
    if (stderr) return new CliError(stderr.slice(0, 2000), Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]) || undefined, exitCode, output)
  }
  return new CliError(`${basename(program)} ${ended(error)}`, undefined, exitCode, output)
}
function ended(error: unknown): string {
  const { killed, signal, code } = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // `execFile` timeout terminates the process with SIGTERM and sets `killed: true`.
  if (killed && signal === 'SIGTERM') return `timed out after ${TIMEOUT_MS / 1000} s`
  if (signal) return `was stopped by ${signal}`
  if (typeof code === 'number') return `exited with code ${code}`
  return typeof code === 'string' ? `could not run: ${code}` : 'failed'
}
export interface Tally { skipped: number }
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : [] })
  if (tally) tally.skipped += list.length - items.length
  return items
}
/** Splits `gh api --include` output into its HTTP status, its header block and its body; a 304 answer has no body. */
export function included(raw: string): { status: number; headers: string; body: string } {
  const split = raw.search(/\r?\n\r?\n/)
  if (split < 0) throw new Error('GitHub returned no HTTP headers')
  const headers = raw.slice(0, split)
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(headers)?.[1])
  if (!Number.isFinite(status)) throw new Error('GitHub returned no HTTP status')
  return { status, headers, body: raw.slice(split).trim() }
}
/** The validators of an earlier conditional read, sent so an unchanged resource answers 304 instead of its body. */
export interface ConditionalCache { etag?: string; lastModified?: string }
/**
 * What a conditional read answered: `notModified` for HTTP 304, which GitHub does not charge against the rate limit and
 * which leaves the caller's kept body valid, or the body with the validators to keep and whether a next page exists.
 */
export type ConditionalRead<T> = { notModified: true }
  | { notModified: false; value: T; etag?: string; lastModified?: string; more: boolean }
/** A conditional read's answer before its schema is applied to the body. */
type ConditionalAnswer = { notModified: true }
  | { notModified: false; body: string; etag?: string; lastModified?: string; more: boolean }
/** Rewrites Feishu error 232011 (bot not in chat) with remediation instructions. */
function membership(error: unknown): unknown {
  if (!(error instanceof CliError) || error.code !== 232011) return error
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  return new CliError(hint, error.code, error.exitCode)
}
/**
 * Executes gh, lark-cli, and git subprocesses with deployment account credentials, timeouts, and abort signals.
 * Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
 */
export class Commands {
  /**
   * @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
   * @param environment - variables overriding `process.env` for every command (such as isolated git settings).
   */
  constructor(private readonly resolved: () => Deployment, private readonly environment: Record<string, string | undefined>,
    private readonly signal: AbortSignal, private readonly scope?: string) {}
  get deployment(): Deployment { return this.resolved() }
  /** The repository every call resolves under: the one this instance is scoped to, or the deployment's primary. */
  get repository(): string { return this.scope ?? this.deployment.repository }
  withSignal(signal?: AbortSignal): Commands {
    return signal ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal]), this.scope) : this
  }
  /** The same CLI, commands and credentials, resolving every path under `repository` instead of the primary one. */
  for(repository: string): Commands { return new Commands(this.resolved, this.environment, this.signal, repository) }
  async run(program: string, args: string[], cwd?: string): Promise<string> {
    try { return await this.execute(program, args, cwd) } catch (error) { throw commandError(error, program) }
  }
  /** Starts one CLI process and returns its stdout, leaving a non-zero exit as the raw error so a caller can read what it printed. */
  private async execute(program: string, args: string[], cwd?: string): Promise<string> {
    const { stdout } = await exec(program, args, { cwd, signal: this.signal, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...this.environment, GH_PROMPT_DISABLED: '1', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
    return stdout
  }
  /** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
  async gh<T>(args: string[]): Promise<T> { return JSON.parse(await this.run(this.deployment.github.cli, args)) as T }
  /**
   * Calls the GitHub API on a path within the configured repository, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string') return this.run(this.deployment.github.cli, ['api', this.path(schema), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.gh(['api', this.path(path), ...flags]))
  }
  /**
   * Calls the GitHub API on a path within the configured repository conditionally: the validator of an earlier read is
   * sent, and an unchanged resource answers HTTP 304, which GitHub does not charge against the rate limit, so the caller
   * keeps the body it read before. It reads one page; `more` says GitHub has a next page of the same list.
   * @throws CliError with GitHub's HTTP status as `code` on failure, a 403 rate limit included, never `notModified`.
   */
  async apiConditional<T>(schema: z.ZodType<T>, path: string, cached?: ConditionalCache): Promise<ConditionalRead<T>> {
    const answer = await this.conditional(path, cached)
    if (answer.notModified) return answer
    const { body, ...rest } = answer
    return { ...rest, value: schema.parse(JSON.parse(body)) }
  }
  /** Reads a GitHub API path within the configured repository conditionally and returns its body as raw text, such as a file. */
  async textConditional(path: string, cached?: ConditionalCache): Promise<ConditionalRead<string>> {
    const answer = await this.conditional(path, cached)
    if (answer.notModified) return answer
    const { body, ...rest } = answer
    return { ...rest, value: body }
  }
  /** Runs one conditional GET and parses its answer, accepting a 304 both as a printed status line and as gh's non-zero exit for one. */
  private async conditional(path: string, cached?: ConditionalCache): Promise<ConditionalAnswer> {
    const validators = cached?.etag ? ['-H', `If-None-Match: ${cached.etag}`]
      : cached?.lastModified ? ['-H', `If-Modified-Since: ${cached.lastModified}`] : []
    const args = ['api', this.path(path), '--include', ...validators]
    let raw: string
    try { raw = await this.run(this.deployment.github.cli, args) }
    catch (error) {
      // A 304 exits gh non-zero while it still printed its status line and headers; every other failure keeps its error.
      let printed: ReturnType<typeof included> | undefined
      try { if (error instanceof CliError && error.output) printed = included(error.output) } catch { /* Keep the failure itself. */ }
      if (printed?.status === 304 || (error instanceof CliError && error.code === 304)) return { notModified: true }
      throw error
    }
    const answer = included(raw)
    if (answer.status === 304) return { notModified: true }
    const etag = /^etag:\s*(.+)$/im.exec(answer.headers)?.[1]?.trim()
    const lastModified = /^last-modified:\s*(.+)$/im.exec(answer.headers)?.[1]?.trim()
    return { notModified: false, body: answer.body, ...etag ? { etag } : {}, ...lastModified ? { lastModified } : {},
      more: /rel="next"/i.test(answer.headers) }
  }
  /** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const pages = z.array(z.array(z.unknown())).parse(await this.gh(['api', this.path(path), '--paginate', '--slurp']))
    return validItems(item, pages.flat(), tally)
  }
  /**
   * Calls an account-level GitHub API path, one that is not under a repository (the notifications list).
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  async account<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async account(path: string, ...flags: string[]): Promise<string>
  async account<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    if (typeof schema === 'string') return this.run(this.deployment.github.cli, ['api', this.relative(schema, 'the account'), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.gh(['api', this.relative(path, 'the account'), ...flags]))
  }
  /** Fetches all pages of an account-level GitHub API list, skipping items that fail schema validation. */
  async accountPages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const pages = z.array(z.array(z.unknown())).parse(await this.gh(['api', this.relative(path, 'the account'), '--paginate', '--slurp']))
    return validItems(item, pages.flat(), tally)
  }
  private path(path: string): string {
    const relative = this.relative(path, 'the configured repository')
    return relative ? `repos/${this.repository}/${relative}` : `repos/${this.repository}`
  }
  /** Rejects a path that leaves the GitHub API or traverses, without naming arguments that may carry message text. */
  private relative(path: string, subject: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error(`GitHub calls are restricted to ${subject}`)
    return path
  }
  /**
   * Runs the Feishu bot's `lark-cli` and returns the JSON `data` payload.
   * @throws CliError with Feishu's error code on failure (rewriting 232011 when the bot is not in the chat).
   */
  async lark<T>(args: string[], cwd?: string): Promise<T> {
    const bot = this.deployment.feishu
    if (!bot) throw new Error('The Feishu Source has no working bot CLI')
    const output = await this.run(bot.cli, [...args, '--as', 'bot', '--format', 'json'], cwd)
      .catch((error: unknown) => { throw membership(error) })
    const result = JSON.parse(output) as { ok: boolean; data: T; error?: { code?: number; message?: string } }
    const code = result.error?.code
    if (!result.ok) throw membership(new CliError(`${result.error?.message ?? 'Feishu command failed'}${code ? ` (${code})` : ''}`, code))
    return result.data
  }
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  async git(args: string[], cwd: string): Promise<string> { return this.run('git', args, cwd) }
}

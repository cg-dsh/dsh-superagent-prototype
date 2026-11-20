/**
 * Identifies a GitHub thread across repositories.
 *
 * The deployment's primary repository keeps the bare number it has always used (`github:14`), so stored threads, cursors and
 * links stay valid; any further repository is qualified (`github:owner/name#14`). A bare id therefore always means the
 * primary repository, which is the only reading that keeps existing state unambiguous.
 */

/** The address of a thread in `repository`, bare for the primary repository and `owner/name#n` otherwise. */
export function githubThreadId(repository: string, number: number, primary: string): string {
  return sameRepository(repository, primary) ? String(number) : `${repository}#${number}`
}

/** The Issue or PR number a thread id names, in either form. */
export function threadNumber(id: string): number {
  const hash = id.lastIndexOf('#')
  return Number(hash === -1 ? id : id.slice(hash + 1))
}

/** The repository a thread id names, falling back to the primary for the bare form. */
export function threadRepository(id: string, primary: string): string {
  const hash = id.lastIndexOf('#')
  return hash === -1 ? primary : id.slice(0, hash)
}
/**
 * The repository any GitHub thread id names, including the default branch's CI thread (`ci:<branch>` for the primary,
 * `ci:<owner/name>#<branch>` for another repository).
 */
export function threadRepositoryOf(id: string, primary: string): string {
  return threadRepository(id.startsWith('ci:') ? id.slice(3) : id, primary)
}

/** True when two `owner/name` values name the same repository, ignoring case as GitHub does. */
export function sameRepository(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

/** The id of the default branch's CI thread, bare for the primary repository and qualified otherwise. */
export function branchCiThreadId(branch: string, repository: string, primary: string): string {
  return sameRepository(repository, primary) ? `ci:${branch}` : `ci:${repository}#${branch}`
}

/** The Issue or PR number a follow thread names (`github:14` or `github:owner/name#14`), or undefined for another source. */
export function pullNumberFromThread(thread: string, source = 'github'): number | undefined {
  if (!thread.startsWith(`${source}:`)) return undefined
  const number = threadNumber(thread.slice(source.length + 1))
  return Number.isFinite(number) && number > 0 ? number : undefined
}

/** The Thread key an Issue or PR carries, in the source's key space. */
export function githubThreadKey(repository: string, number: number, primary: string): string {
  return `github:${githubThreadId(repository, number, primary)}`
}

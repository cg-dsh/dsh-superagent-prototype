# Watching more than one repository

Decision: **one GitHub source, several repositories** (option B), because the agent account and the workflow are shared.

- `Catglobe/Catglobe` is the **primary** repository: its thread ids stay bare (`github:14`), so every stored Thread,
  subscription, KV cursor and link keeps its meaning.
- Every other repository is qualified (`github:Catglobe/SlackIntegration#14`), and a bare id always means the primary.
- **Policy is shared**: the admission table, allowed senders and accept mode come from the one source, so a second
  repository inherits Catglobe's rules. Revisit only if a repository needs a different trust boundary.
- **The clone is lazy and lives in `prepare`** (option A): the first Ticket in a repository clones it, under a lock.

## Landed

- `src/sources/github-thread.ts` — `githubThreadId`, `githubThreadKey`, `threadNumber`, `threadRepository`,
  `sameRepository`, `branchCiThreadId`, `pullNumberFromThread`; 7 tests.
- `repositories: string[]` in `GithubAccountsSchema`. `resolveDeployment` probes every repository for read and push
  access, canonicalises its name and lists it once; setup no longer refuses a non-empty list. `Deployment.repositories`
  holds the primary first.
- `Commands.for(repository)` resolves every path under that repository, and `SourceContext.scope(repository)` builds the
  context of one repository from the factory that owns the command layer. The primary repository's scoped context keeps
  the very commands the source was given, so one repository reads exactly what it read before.
- **One notification read per round**: `pollNotifications` reads the account's notifications once through
  `Commands.account`, dispatches each by `notification.repository.full_name`, ignores repositories it does not watch, and
  keys retries by thread id.
- **Everything repository-scoped runs per repository**, inside the one round loop: observed streams, default-branch CI,
  the PRs of open Tickets with their checks, the comment sweep and subscribed Threads. Stream cursors, the default-branch
  CI baseline, per-PR CI state and the sweep time are stored per repository; the primary keeps its existing keys.
- **Trigger ids and thread ids follow the repository**: the four trigger builders and `branchCiTrigger` take the thread id;
  a Trigger from another repository addresses `github:owner/name#n`, and `bindThread`/`threadClosed` use that same id.
- **Per-Ticket `DSH_SUPERAGENT_GITHUB_REPOSITORY`** comes from the Ticket's own thread, so prepare clones and checks out
  the repository the work belongs to; a Ticket that did not start on GitHub uses the primary.
  The Executor's PR read and claim use the same repository.
- The panel edits the further repositories as a textarea, one `owner/name` per line.

## The layer beneath: every read is scoped to one repository

`Commands.api(path, ...)` resolves the path under `repos/<commands.repository>/`, and every repository-scoped GitHub read
and write goes through it. A scoped `Commands` therefore carries one repository — `commands.for(repository)` — and every
caller that can touch more than the primary uses the scoped one. A read that silently goes to the wrong repository either
finds nothing or finds a same-numbered Issue that belongs to someone else.

The notifications list is the exception: it belongs to the account, not a repository, so `Commands.account` calls it
without a repository prefix.

## The scoped context must be injected, not built inside the poller

Attempting the per-repository loop from inside the poller failed on the source's own tests, and the failure is
informative: a scoped `Commands` constructed by the source (`ctx.commands.for(repository)`) is not the command layer the
tests replace, so one test ended up executing the fixture's `/bin/false` CLI for real ("false exited with code 1"). The
same applies to the context: fixtures build one directly, so a context manufactured inside the poller bypasses whatever
those fixtures provide.

So the factory that builds the source context, not the poller, owns the scoping: `sourceContextOf` supplies a
`scope(repository): SourceContext` whose `commands` and `repository` come from it, and a fixture may supply its own
`scope` (or omit it, and the poller falls back to the context it was given). The poller only calls
`ctx.scope?.(repository)`.

## One notification read, per-repository watchers for the rest

The notifications list is account-wide and cannot be filtered to a repository, so it is read **once** per round by a
single loop; each notification is dispatched to the context of its own repository (`notification.repository.full_name`,
checked against `deployment.repositories`). Everything repository-scoped — pull requests and their checks, Issue state,
the comment sweep, the observed streams — runs in one watcher per repository, each with its own scoped commands, its own
cursor and its own part of the one round.

That keeps the call volume at one notification read plus the repo-scoped work, and still gives each repository an
independent view of what it owes.

## Where each repository comes from

| what | where the repository comes from |
|---|---|
| `pollThread(ctx, round, thread)` | `threadRepository(thread.ref.id, primary)`, filtered to the scoped context's repository |
| `intakeComments(ctx, ref, since, round)` | `ref.thread`, carried on `PullRef` |
| `nameThread(ctx, number, title)` | the scoped context's repository |
| `pollChecks(ctx, round, number, pr)` | the scoped context's repository; the PR was read through it |
| `failed(ctx, round, thread, error)` | the thread id, which names the repository |
| notification reads | `notification.repository.full_name` |
| Ticket pull requests | the thread ids on the Ticket's `follows` |
| the Execution environment | the Ticket's originating thread |

## The prepare command

Apply this in the Execution settings; it clones each repository on first use under a lock, then adds the Ticket's
worktree from the pull request's head.

```sh
set -e
slug=$(printf %s "$DSH_SUPERAGENT_GITHUB_REPOSITORY" | tr '[:upper:]/' '[:lower:]-')
clone="$HOME/src/$slug"
mkdir -p "$HOME/src"
exec 9>"$HOME/src/.$slug.lock"
flock -w 540 9                                  # under PREPARE_TIMEOUT_MS, serialised per repository
if [ ! -d "$clone/.git" ]; then
  tmp="$HOME/src/.$slug.partial.$$"
  rm -rf "$tmp"
  GIT_TERMINAL_PROMPT=0 git clone --quiet "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "$tmp"
  mv "$tmp" "$clone"
fi
GIT_TERMINAL_PROMPT=0 git -C "$clone" fetch --no-tags \
  "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" \
  "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
git -C "$clone" worktree add -B "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" \
  "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
```

`worktree add` creates `$DSH_SUPERAGENT_DIR` last, so a failed prepare never leaves a directory that the executor would
mistake for a prepared workspace.

## Verification

Add `Catglobe/SlackIntegration` to the list and check, in order: setup accepts it (access probed), a mention there
creates a Trigger and a Ticket, its first Ticket clones `~/src/slackintegration` under the lock, its PR binds to the
Ticket (`agent/<name>` in that repository), CI on its PR reaches the Ticket, and the Ticket's end cleans its worktree.
Alongside it, Catglobe's bare `github:14` threads and their cursors must keep working untouched.

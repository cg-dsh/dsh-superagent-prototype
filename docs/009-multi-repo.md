# Watching more than one repository

Decision: **one GitHub source, several repositories** (option B), because the agent account and the workflow are shared.

- `Catglobe/Catglobe` is the **primary** repository: its thread ids stay bare (`github:14`), so every stored Thread,
  subscription, KV cursor and link keeps its meaning.
- Every other repository is qualified (`github:Catglobe/SlackIntegration#14`), and a bare id always means the primary.
- **Policy is shared**: the admission table, allowed senders and accept mode come from the one source, so a second
  repository inherits Catglobe's rules. Revisit only if a repository needs a different trust boundary.
- **The clone is lazy and lives in `prepare`** (option A): the first Ticket in a repository clones it, under a lock.

## Landed

- `src/sources/github-thread.ts` — `githubThreadId`, `threadNumber`, `threadRepository`, `sameRepository`,
  `branchCiThreadId`, `pullNumberFromThread`, `githubThreadKey`; 7 tests.
- `repositories: string[]` in `GithubAccountsSchema`, probed (read + push) and canonicalised per repository in
  `resolveDeployment`, exposed as `Deployment.repositories`. A non-empty list is refused with
  `repositoriesUnsupported` until the work below is done.
- Every thread key and cursor in `src/sources/github.ts` and `github-pull.ts` is built through the module, currently
  with `ctx.deployment.repository`, so the strings are unchanged.

## The layer beneath: every read is scoped to one repository

`Commands.api(path, ...)` resolves the path under `repos/<deployment.repository>/`, and every GitHub read and write goes
through it. A second repository therefore needs the command layer to carry a repository — `commands.for(repository)` — and
every caller of `api`, `gh` and `pages` that can touch more than the primary must use the scoped one. This is what the five
signatures sit on top of, and why a partial change is not safe: a read that silently goes to the wrong repository either
finds nothing or finds a same-numbered Issue that belongs to someone else.

## One notification read, per-repository watchers for the rest

The notifications endpoint is account-wide and cannot be filtered to a repository, so it is read **once** per round by a
single loop; each notification is dispatched to the watcher of its own repository (`notification.repository.full_name`,
checked against `deployment.repositories`). Everything repository-scoped — pull requests and their checks, Issue state,
the comment sweep, the observed streams — runs in one watcher per repository, each with its own scoped commands, its own
round and its own cursor.

That keeps the call volume at one notification read plus the repo-scoped work, and still gives each repository an
independent view of what it owes.

## The scoped context must be injected, not built inside the poller

Attempting the per-repository loop from inside the poller failed on the source's own tests, and the failure is
informative: a scoped `Commands` constructed by the source (`ctx.commands.for(repository)`) is not the command layer the
tests replace, so one test ended up executing the fixture's `/bin/false` CLI for real ("false exited with code 1"). The
same applies to the context: fixtures build one directly, so a context manufactured inside the poller bypasses whatever
those fixtures provide.

So the registry, not the poller, owns the scoping: `applyGithub` receives (or the context exposes) a
`scope(repository): SourceContext` whose `commands` and `repository` are supplied by the factory, and the poller only
calls it. A fixture can then supply its own scoped view and the tests keep control of the command layer.

## Remaining: thread the repository through five functions

| function | where the repository comes from |
|---|---|
| `pollThread(ctx, round, thread)` | `threadRepository(thread.ref.id, primary)` — a thread already knows its repository |
| `intakeComments(ctx, ref, since, round)` | add `repository` to `PullRef`; `pollThread` and the notification handler both know it |
| `nameThread(ctx, number, title)` | the thread id, which every caller already holds |
| `pollChecks(ctx, round, number, pr)` | add `base: { repo: { full_name } }` to `PullSchema`; the PR's own repository |
| `failed(ctx, round, number, error)` | the thread id, for the `github:…` key it patches |

The four trigger builders (`commentTrigger`, `issueTrigger`, `pullTrigger`, `ciTrigger`) take the thread id as a
parameter instead of formatting `String(number)`; `branchCiTrigger` takes `branchCiThreadId(...)`.

## Then the enables

1. Notification filter: `sameName(notification.repository.full_name, repository)` → membership in
   `ctx.deployment.repositories`.
2. `DSH_SUPERAGENT_GITHUB_REPOSITORY` per Ticket: `threadRepository(trigger.threads[0].id, deployment.repository)` in the
   Source `environment.value` callback, instead of `deployment.repository`.
3. Panel: a field for the list (one `owner/name` per line).
4. Remove `repositoriesUnsupported` from `src/setup.ts`, `src/deployment.ts` and the locale.
5. Apply the prepare command below in the Execution settings.

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

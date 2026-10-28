# Issue import: start a task from a GitHub issue

Date: 2026-10-28. Status: proposed, awaiting the maintainer's approval. Applies to: `src/core/issue-import.ts`, `src/api/ops.ts`, `src/api/caller-policy.ts`, `src/api/v2-compat.ts`, `src/api/protocol.ts`, `src/core/errors.ts`, `docs/protocol.md`, `docs/protocol.schema.json`, generated Rust protocol types.
Builds on: [app redesign](2026-10-27-app-redesign-design.md) (the New task composer and its "From an issue" attach option) and [route explanation](2026-10-28-route-explanation-design.md) (the pattern for a read-only composer operation).

## Problem

The New task composer offers "From an issue". Nothing in the API can read a GitHub issue, and a client must not call GitHub or `gh` itself (ARCH-1, ARCH-2). The composer UI comes later; this spec covers the service operations it will call.

## Decisions

1. **Two read-only operations.** `issue.import {repo, issue}` returns one issue: number, title, body, label names, URL, state and `truncated` flags. `issue.search {repo, query, state?, limit?}` returns summaries without bodies for a picker. Neither starts, reserves or writes anything, and neither publishes an event. Both are v3 only.
2. **`gh`, not a token.** pacer has no GitHub client. It runs `gh issue view` or `gh issue list --json …` with an argument vector (SEC-5): `--repo=github.com/<owner>/<name>` names the host so `GH_HOST` cannot redirect it, and `--search=<query>` keeps the query one argument. The user's own `gh` login is used; pacer never reads, stores or sends a token. Prompts, colour and the update notifier are turned off, and a call times out after 20 s.
3. **Repository from git, not from the request.** `repo` must be a registered repository key. The GitHub `owner/name` comes from that checkout's `origin` remote, read at call time with `repoKey`, the parser that derives repository keys. Only github.com is supported. An issue URL must name the same repository, and search results outside it are dropped (a `repo:` qualifier in the query cannot widen the search).
4. **Untrusted content.** The title, body and label names are returned as plain text. C0/C1 control characters (except newline and tab in the body) and bidirectional overrides and isolates are removed, CRLF becomes LF, the title is cut to 300 characters, labels to 100 characters and 50 entries, and the body to 64 KiB of UTF-8 on a code point boundary. `truncated` reports a cut. The URL is passed through only when it is a canonical github.com issue URL for the same number; otherwise it is rebuilt. A pull request number is refused. Clients render the fields as text, and the user confirms before anything becomes a task request.
5. **Planners and people only.** Executor sessions (`PACER_ROLE=executor`, a pacer worktree, or a work grant) are refused in the caller policy and again in the core.
6. **Typed errors.** Each error has a `CoreError` code for transports and `data.reason` for clients: `gh_missing` and `gh_failed` → `unavailable` (503); `gh_unauthenticated` → `not_allowed`; `rate_limited` → `rate_limited` (429); `not_github`, `unknown_repo`, `repo_mismatch` → `invalid_input`; `repo_not_found`, `issue_not_found` → `not_found`. `unavailable` and `rate_limited` are new codes (API-4). They are additive and listed in the protocol doc. JSON-RPC carries only the code and hint, which is enough to tell the cases apart there.
7. **Small published schema.** The published params are plain strings (`issue` is `"217"`, `"#217"` or a URL), and the core validates bounds with its own schema. Bounded strings each generate a Rust newtype, and `pacer-client-protocol` is close to its CRATE-3 budget of 10,000 generated lines. The crate needs an area split before more operations are added.

## Testing

`test/issue-import.test.ts` uses `gh` output recorded from the public `lamtuanvu/pacer` repository (`test/fixtures/issue-import/`) and a fake runner, so tests never reach the network. They cover argv, URL and number parsing, refusal of other repositories, sanitizing and caps, every error reason, the executor refusal and the operation registry. Live validation runs the service with a sandboxed `PACER_HOME` and calls both operations against `lamtuanvu/pacer`.

## Open decisions

- GitHub Enterprise hosts are not supported. Supporting them would mean trusting the remote's host for `--repo`.
- The CLI has no `pacer issue` command yet (ARCH-8). The composer is the first client.

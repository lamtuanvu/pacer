# File path search design

## Goal

The app's ⌘K command menu has a Files scope (board 5c, `CommandMenu.dc.html`): typing part of a path lists matching files, each with its repository and, when a running task has changed it, a "changed by the running task" sub-line. Clients only show data the service provides (ARCH-1, ARCH-2), so the service needs a read-only operation that searches file paths in the repositories already registered with pacer.

Out of scope: file contents, full-text search, opening or previewing files (see the [file viewer design](2026-10-27-terminal-links-and-file-viewer-design.md)), searching unregistered folders, and the menu UI itself.

## Operation

`files.search`, protocol 3 only (it is added to `V3_ONLY_OPS`; 2.x stays frozen). Adding it is additive (API-1).

Params (strict object; unknown fields are `invalid_input`):

| Field | Type | Notes |
|-------|------|-------|
| `query` | string, 1–200 chars | Trimmed; whitespace-only is `invalid_input`. Case-insensitive. |
| `repo` | string, ≤ 512 chars, optional | A registered repository key (`repo.list`). Unknown keys are `invalid_input`. Omitted means every registered repository. |
| `limit` | integer 1–50, optional | Default 20. |

Result:

```ts
{
  query: string;                 // the trimmed query
  results: {
    repo: string;                // repository key
    repoLabel: string;           // display label, as repo.list shows it
    path: string;                // repo-relative, "/"-separated
    size?: number;               // bytes, only for a regular file that could be stat'ed
    ranges: [number, number][];  // matched [start, end) offsets into path (UTF-16 code units)
    changedBy?: { task: string; title?: string }[]; // running local tasks whose worktree changed this path
  }[];
  truncated: boolean;            // more matches existed than `limit`
  repos: { key: string; state: "ok" | "skipped" | "timeout" | "too_large" | "error" }[];
}
```

Matching, best first:

1. the basename contains the query as a substring;
2. the path contains the query as a substring;
3. the query's characters (whitespace removed) appear in order in the path (a greedy subsequence; each contiguous run is one range).

Within a tier, files changed by a running task come first, then shorter paths, then paths in byte order. A path that matches none of the tiers is not returned.

## Data sources and limits

- **Repositories.** `listRepos` with a read-only context, so the call never prunes or writes the registry. At most 20 repositories are scanned; ones marked unreachable are reported as `skipped`.
- **Paths.** `git -c core.fsmonitor=false -C <root> ls-files -z --cached` as an argument vector through the bounded git reader (2 s per repository). Only tracked files are listed, so `.git` is never included and ignored files are not either. Output past 8 MiB (counted in characters) or 200,000 paths is cut there and the repository reports `too_large`; matches in the part kept are still returned. Listings are cached in memory for 5 s per repository root so each keystroke does not spawn git; nothing is written to disk.
- **Containment.** Every path from git is checked: it must be relative, contain no `..`, `.` or empty segment and no NUL, and must not start with `.git/`. Any other path is dropped, so no result names a file outside the repository root. `size` comes from `lstat` of the joined path only for the returned results (≤ 50) and is omitted for symlinks and non-regular files.
- **Changed by running tasks.** The read-only task store view (`openReadOnlyStore`, as `dispatch.explain` uses) lists running tasks. For up to 8 local running tasks whose repository key matches, the service runs `git diff --name-only -z` against the task's base (merge base when the run made a new branch) in the task worktree, with a 1 s bound. A failure or timeout only drops the annotation. Remote runs are skipped, as their changes are on the host until the run ends. A file a task added does not appear unless it is tracked in the registered checkout.

## Security

- Read-only: no writes to the registry, task store or disk, no plugin start. The only subprocess is `git` with an argument vector; the query is never passed to git or a shell (API-5, SEC-5).
- Executors are refused: the caller policy rejects `files.search` for `PACER_ROLE=executor`, and the core function also refuses executor sessions and work grants (which do not allow it either). Searching the person's repositories is a planner and person surface; executors work in their own worktree.
- Only repositories the person registered are searched, and returned paths are repo-relative and contained as described above.

## Validation

- `test/files-search.test.ts` with temp-dir git repositories: tiers and ranges, `.gitignore` respected, untracked files absent, `repo` filter and unknown key, limits and `truncated`, query bounds, executor refusal through the caller policy and the core, unsafe paths from a fake git dropped, timeouts and oversize listings reported per repository, running-task annotation, and no registry write.
- `bun run protocol:doc` and `cargo xtask gen` regenerate the protocol docs, schema and Rust types; the freshness checks pass.
- Live: `bun run live up --id files --seed ui`, then `bun run live pacer --id files -- api call files.search --params-file <file> --json` against a sandboxed `PACER_HOME`.

#!/usr/bin/env bash
# gen-review.sh <task> <out-file> <report-name> [note-file]
# Writes an independent-review brief for .work/worktrees/<task> at its current HEAD.
set -euo pipefail

task="$1"; out="$2"; report="$3"; note="${4:-}"
root="$(git rev-parse --show-toplevel)"
ctx="$root/.claude/feature-orchestrator/m2-parallel/ctx"
d="$root/.work/worktrees/$task"
mb="$(git -C "$d" merge-base HEAD origin/main)"
head="$(git -C "$d" rev-parse HEAD)"
br="$(git -C "$d" branch --show-current)"

{
cat <<EOF
# Independent project review: $br

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: \`$d\`
- Branch: \`$br\`
- Base (merge-base with origin/main): \`$mb\`
- Reviewed head: \`$head\`
- Commits in scope:
EOF
git -C "$d" log --format='  - %h %s' "$mb..$head"
cat <<EOF
- Raw changes: \`git diff $mb..$head\` and \`git log -p $mb..$head\`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

## Requirements

The implementation brief follows. For any earlier commit in scope that the brief does not cover, its commit message is the stated requirement; also check that what it claims (ops registered, ledger rows) is actually true in the code.

---
EOF
cat "$ctx/$task-v2.md"
cat <<EOF
---

## Governance context

Read first: \`AGENTS.md\`, \`.project/constitution.md\`, \`.project/context.md\`, \`.agents/skills/project-review/SKILL.md\`.
Rules that apply to these paths: \`.project/rules/repository.md\`, \`.project/rules/code-and-testing.md\`, \`.project/rules/rust.md\`, \`.project/rules/rust-crates.md\`, \`.project/rules/architecture.md\`, \`.project/rules/api-protocol.md\`, \`.project/rules/security.md\`.
Reviewer definitions: \`.project/reviewers/architecture.md\`, \`.project/reviewers/protocol-compat.md\`, \`.project/reviewers/qa.md\`, \`.project/reviewers/security.md\`. Also check \`.project/decisions.md\` for relevant open decisions.

## What to check

- The change does what the requirements ask, or each deviation is justified and safe.
- Native Rust behavior matches the TypeScript reference byte-for-byte for every case the parity claims cover (error codes, messages, refusals), and anything not native is forwarded unchanged.
- Bridges and forwarding preserve the caller's auth, enforcement identity and timeouts; no new privilege or unauthenticated path.
- Tests actually exercise the claims (parity tests compare against the TypeScript path, not a fixture of themselves). \`docs/testing/m2-ledger.md\` rows and totals match what the code registers.
- No machine-specific paths or personal emails in tracked files; commits are signed off (DCO).

You may run read-only and test commands (git, rg, cargo test, cargo clippy, cargo fmt --check, bun test for the touched tests). Do not edit tracked files, commit, push, or change branches. Never touch the real pacer install (\`/Applications/pacer.app\`, \`~/.local/bin/pacer*\`, \`~/.pacer\`, \`com.pacer.serve\`); do not run \`bun run live\`. If a check cannot run, record it as UNVERIFIED.
EOF
if [[ -n "$note" ]]; then printf '\n## Re-review context\n\n'; cat "$note"; fi
policy="$root/.claude/feature-orchestrator/m2-parallel/notes/live-policy.md"
if [[ -f "$policy" ]]; then printf '\n## Live-validation policy\n\n'; cat "$policy"; fi
cat <<EOF

## Deliverable

Write the report to \`$d/.work/reviews/$report\` (create the directory; \`.work/\` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.
EOF
} > "$out"
echo "$out: $(wc -l < "$out") lines, head $head"

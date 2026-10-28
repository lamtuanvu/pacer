---
name: project-review
description: Use when reviewing a plan or change in this repository, or before delivering changed code as complete.
---

# Project review

Read [project-governance](../project-governance/SKILL.md), then apply the project's
review gate in `.project/rules/repository.md` (REPO-10). Rules and reviewer criteria
remain canonical under `.project/`; this entry point needs no Claude plugin.

## Establish the scope

For a PR, use its actual target base. For local work include staged, unstaged and
relevant untracked files. Record exclusions. Identify the base and reviewed head;
for uncommitted files also record a content fingerprint and file inventory so HEAD
alone cannot misidentify the reviewed revision. A clean diff is not an audit.

## Independent review

Give a fresh reviewer the task requirements, scope/base, governance context packet
and raw changes, without the implementer's preferred verdict. Select applicable
reviewer definitions from the context index and cover repository rules even for
docs-only changes. Do not hard-code reviewer counts or language filters.

Use fresh subagents where supported and authorized, or a separate reviewer/session.
The independent review required by REPO-10 cannot be replaced by implementer
self-review. If unavailable, report the gate UNVERIFIED and deliver a progress
handoff, not a completion claim. Specialist reviews may run sequentially.

Reviewers inspect and report; they do not modify code or grant exceptions. Each
finding names its rule/source (or advisory status), severity, location, evidence,
impact and remedy. Separate introduced defects from pre-existing issues.

Check REPO-13 (proposed, amendment 0.15.0; advisory until adopted): the delivery names each delegation or planner-side agent with its executor or model tier and the reason, and states any REPO-11 exception.

Save reports under `.work/reviews/`. Include scope, base/head and working-tree
fingerprint if applicable, reviewer identity/independence, governance version,
actual checks and evidence, unavailable/inapplicable checks, findings, accepted
exceptions, and PASS/FAIL/UNVERIFIED verdict. Missing evidence is never PASS.

## Resolve and verify

For UI-affecting work, follow the canonical
[UI review readiness procedure](../../../.project/rules/ui.md#ui-review-readiness-procedure)
before PR handoff, draft transitions or completion claims.

The implementer fixes confirmed blocking findings, reruns affected checks and
applicable CT-11 live validation, and obtains independent review of the fixes.
A disputed finding needs evidence and reviewer reassessment; do not silently drop
it. Review all changes made after the previous report, including merge resolutions.
Repeat until the gate passes; if a blocker cannot be resolved within authorized
scope, report it and the needed decision without claiming completion.

Nonblocking suggestions may be deferred explicitly. Existing UI report contracts,
waivers and human merge authority remain in force. Before delivery, confirm the
reports cover the final content and summarize evidence and remaining limitations.
Do not publish, push, merge or message others merely to run this skill.

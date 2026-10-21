# Actionable attention and task outcomes

Date: 2026-10-21
Status: UI concept approved; written specification awaiting review.

## Intent

Pacer should tell the user when intervention is necessary while allowing planner-led delivery to finish without a second human acknowledgment. The existing review queue mixes genuine decisions with missing verdict bookkeeping. Accepting a result records a verdict; it does not merge or bring back changes.

The maintainer approved the in-conversation proposal and interactive mockup: replace standalone Review navigation with Needs you, keep execution history in Tasks, and emphasize results, checks, and delivery in task detail. The mockup is illustrative, not production styling or evidence that these capabilities already exist.

Success means a successful planner task with no recorded verdict creates no attention item, explicit human review remains possible, and failures and questions remain visible without implying that all completed tasks await approval.

## Alternatives and decision

Renaming Review alone would preserve the misleading obligation. Removing verdicts entirely would discard useful feedback and send-back workflows. Use actionable attention plus optional verdicts: keep the review API and benchmark labels, but stop using the absence of a verdict as a reason for human attention.

## Scope and boundaries

Change service attention derivation, task review-request metadata, planner handoff tools, shared presentation vocabulary, web/desktop navigation and detail, tray counts, and equivalent CLI/TUI presentation. Preserve existing unrelated navigation and attention categories. Do not add automatic merging, repository polling for merged PRs, inferred acceptance, or transcript-generated quality judgments.

The service owns decisions and state. Clients consume the same attention read model and events. No client-local queue or timer may recreate the old ten-minute review escalation.

## Attention contract

Needs you contains unresolved actionable items:

- Agent questions requiring an answer.
- Execution failures, exhausted attempts, and existing service/account/setup problems under their established rules.
- Completed or partial tasks with a stored failing acceptance result, unless reviewed, resolved, dismissed, or superseded by a retry.
- Partial tasks without failed acceptance results, presented as incomplete work requiring inspection rather than successful completion.
- Explicit human review requests on completed or partial results.

Ordinary done tasks with passing or absent checks do not generate attention merely because no verdict exists. Planner ownership does not suppress actual failures. An explicit review request and failing checks on the same task produce one item; failing checks take precedence, and the request remains visible in detail. Questions retain their blocking precedence. Existing severity ordering and repository scoping remain intact.

Review, retry, resolution, and dismissal remove attention through existing state transitions. Dismissing does not accept a result or add a benchmark label. Snoozing preserves the request while temporarily hiding its attention item. Missing acceptance output is shown as unknown, never as passing. Historical resolved or superseded tasks do not reappear.

## Explicit human handoff

Add optional persisted `reviewRequest: { note: string, at: number }` to task records and expose it additively in task reads, snapshots, and task events. This records a request for a human decision; `source` continues to describe delegation origin and does not identify the reviewer.

Add `task.request_review { id, note, expect_rev? }`. The note is required, trimmed, and limited to 2000 characters. Only done or partial tasks without a verdict, resolution, dismissal, or retry successor are eligible. Mutations use the established task lock and revision conflict handling. Invalid state returns the established conflict error with the current task; invalid note returns invalid_input. Persisting the request increments the revision and publishes the usual task update. Repeating the same note on an eligible requested task is a no-op; changing the note updates the request and timestamp under the same revision guard.

Expose this operation through MCP as `task_request_review` and the CLI task command family. Planner instructions distinguish two actions: after actually reviewing a result, record a verdict using the existing review tool; when a human decision is needed, request review with the specific question or concern. No tool automatically converts executor completion into acceptance.

Existing task.review accept/reject/send_back/retry semantics remain. Request metadata may remain as history after resolution; attention depends on current task state and verdict, not metadata presence alone. Retries do not inherit a human review request.

## Navigation and lists

Replace the standalone Review entry with Needs you and its actionable count. Reuse the existing attention ordering and repository filter. Show the count once in the relevant navigation region rather than duplicating it in the page title. Keep the planner budget strip and other app destinations.

Each attention row shows the task title, plain-language reason, repository, executor, readable time, and a reason-specific action: Answer, Inspect failures, Inspect incomplete work, or Review changes. Repeated row actions use secondary styling. Do not offer bulk acceptance on Needs you, which contains mixed kinds of attention. An empty page says “Nothing needs your attention” and links to Tasks.

Tasks retains running and queued work plus paginated terminal history through task.list. It must not rely on the snapshot's recent-task limit for history. Display execution separately from quality verdict: Completed with Planner accepted only when that provenance is known; otherwise use Accepted. Existing verdict records do not identify who reviewed them, so do not infer planner provenance from task.source. Completed without a verdict shows neutral “Outcome not recorded” in secondary detail. Partial execution reads Incomplete; failed execution reads Failed. A terminal result is never presented as integrated solely because it was accepted.

## Task detail

Order content as result summary, checks and changes, delivery/next action, then collapsed executor transcript and technical routing/cost details. Use stored result summaries when suitable; if the stored report is a transcript rather than a concise summary, show a factual completion sentence and keep the full report in the disclosure. Do not invent an extracted summary.

Failed checks are prominent and expandable. A diff is accessible through the existing diff operation. Delivery shows only known worktree/branch information, and otherwise “Integration not recorded.” No merged status is introduced by this change.

Explicit review offers Mark accepted, Send back, and Reject result; acceptance copy explains that integrating the branch is separate. Failing or incomplete tasks offer inspection and supported send-back/retry actions. Ordinary completed tasks offer View changes and supported rerun/worktree actions without a verdict panel by default; optional verdict controls remain reachable in a labelled disclosure. Running tasks retain progress/session actions. Offer worktree actions only when the existing capability and artifact checks permit them.

Use canonical design-system components and tokens. The mockup's duplicated counts, standalone typography, and sample failure details are not implementation requirements. Real text, counts, and statuses come from the service/shared view model.

## Existing data and compatibility

No destructive migration and no bulk acceptance. Historical done tasks without verdicts simply stop generating missing-verdict attention and remain accessible through Tasks. Existing review labels, dismissed states, retry links, archives, and records stay unchanged. Historical partial work and known failing checks still qualify for attention.

Keep task.review and existing response fields compatible. New metadata and the handoff operation are additive; regenerate protocol documentation. Retain the existing review attention kind for explicitly requested reviews rather than renaming a public enum. Map the new UI wording in shared vocabulary. Preserve the old review route as an alias to Needs you and retain task deep links. Older services use a conservative client fallback that suppresses routine missing-verdict reviews while retaining known failures and other actionable categories; explicit handoff is unavailable with a clear explanation where relevant. Do not falsely claim the older service supports new metadata.

This change does not relax retention safeguards: tasks without verdicts or dismissal remain ineligible under the current archival policy. Leaving the inbox does not imply archival or cleanup. Revisit retention separately if storage becomes a problem.

## Evidence and acceptance criteria

Tests must distinguish done/pass, done/no-checks, done/failing-checks, partial, explicit request, answered question, resolved, dismissed, snoozed, reviewed, and superseded tasks. Include ten-minute passage without escalation, historical records, metadata persistence/restart, request validation, concurrent revisions, retry inheritance, unknown provenance, counts/filter consistency, and legacy route/service behavior.

Live validation must exercise actual delegated completion without a verdict, explicit request and resolution, failed acceptance, question answering, retry/send-back, and history navigation on every affected API/CLI, TUI, web/tray, and desktop surface. Record unavailable behavior as UNVERIFIED. Validate keyboard/focus, accessible names and announcements, empty/error/conflict states, and responsive long-content containment. Capture changed web screens at 1440 pixels in light/dark and 375 pixels for layout changes.

Before claiming implementation complete: run typecheck, the project test command, ui:check, generated protocol/app freshness checks and build; run the live harness and summarize its evidence report. Supply implementer compliance plus independent UI/accessibility and QA reports at the reviewed base/head. Update user documentation and CHANGELOG. Record the durable workflow choice in an ADR during implementation using the repository's numbered naming instruction; the alternative date naming proposal remains unresolved (OD-2).

## Governance references

Constitution established principles P1–P4, P9, P11–P12 and adopted amendment 0.4.0 apply. Follow ARCH-1–5, ARCH-8–9; API-1–6; UI-1–4, UI-6, UI-8–25; CT-1–6 and CT-11; REPO-1–7. UI-19–25 are established by the constitution despite stale Proposed labels in the rule index. UI-7, ARCH-10–11, and other unresolved proposals are not adopted by this design.

Reviewer definitions: .project/reviewers/architecture.md, protocol-compat.md, ui-accessibility.md, and qa.md. Plans and reviewer handoffs must carry these references and applicable rule IDs. Working plans and evidence remain under untracked .work/; tracked documents contain no machine-specific paths or personal emails.

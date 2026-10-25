# Agent-led onboarding

Status: proposed design, awaiting maintainer approval. No runtime changes.

## Intent

A user copies one prompt into their existing coding agent. That agent installs,
sets up and configures Pacer, coordinates account sign-in, verifies a small first
delegation, and offers to continue with real work. Users should not need to learn
strategy YAML, account folders or runner identifiers before receiving value.

The maintainer selected a short prompt backed by a structured, resumable workflow.
Account creation supports Claude/Codex subscription accounts and API providers.
Credentials stay outside chat. Adding executors does not restart the conversation;
changing the planner account takes effect in a new session.

## Approaches

1. Prompt and prose guide: fastest, but each agent must infer recovery and readiness.
2. Prompt backed by structured setup state: selected; shares behavior with the app,
   supports recovery, and keeps agent interpretation small.
3. Dedicated onboarding agent: adds infrastructure and a separate chat surface.

The following scope and defaults are the designer's proposals, subject to approval.

## Scope

Deliver the prompt in README quickstart and the existing app Setup screen. Maintain
one public agent-readable onboarding guide in `docs/agent-onboarding.md`, including
bootstrap instructions for machines without Pacer. Documentation describes shipped
commands only; proposed names below are not commands users can run today.

Support local macOS/Linux installs and supported planner adapters. Prefer the
current agent as planner when it is supported and identifiable; otherwise ask one
planner question. Reuse installed, configured accounts before offering new ones.
Missing provider CLIs use official installation instructions through adapters;
do not install every detected or supported provider. Preserve existing strategy,
integrations and account homes. No purchases, remote host onboarding, automatic
planner-session migration or new embedded chat are included.

## Copyable prompt

The published prompt will include the canonical raw GitHub URL for the guide:

> Help me install and set up Pacer using its official agent onboarding guide at
> [canonical guide URL]. Inspect my existing setup first and preserve it. Use this
> agent as planner if supported, and help me connect an executor. Explain the setup
> changes together and obtain required consent before applying them. Keep passwords,
> tokens and API keys outside chat. Guide me through provider sign-in, resume setup,
> then verify a small practice delegation and review its result. Report anything
> still unverified, then offer to start my real task.

The placeholder is replaced before publication; it is not the final copyable text.
The guide must distinguish installation from upgrades and avoid forcing the latest
release over an existing supported installation. After installation, query the
installed version/capabilities and follow its supported workflow contract. If the
guide is unreachable or incompatible, report the blocker rather than guess flags.

## User journey

1. Inspect platform, Pacer version, service and setup state, installed tools and
   sanitized account metadata. Discovery does not start provider apps or read secrets.
2. Propose the smallest usable setup: planner, executor and changes needed. Show
   service/background behavior, integration file previews and undo information.
   Explain that executor launches use Pacer's existing permission-bypass behavior.
   Obtain required service and integration consent against the actual preview;
   separate confirmations are needed only when existing contracts require them or
   the plan changes materially. Do not buy subscriptions or enable paid usage by default.
3. Install/configure missing components using supported operations. Preserve existing
   settings; conflicts return an actionable explanation rather than overwrite them.
4. Connect accounts as described below. A sign-in handoff pauses only dependent work.
5. Recheck setup and diagnostics. Report configured integration separately from
   proven invocation; installed files and handler probes do not prove host invocation.
   If the active agent cannot load a new integration until restart, say so and provide
   a continuation instruction for a new session. Do not claim the current session loaded it.
6. Run the existing tiny scratch-repository delegation, inspect its diff and run
   acceptance, then record planner review. Disclose that the test consumes a small
   amount of provider capacity. No user project edits are needed for this test.
7. Report what works, what remains unknown, and how to undo setup; offer to work on
   the user's actual task without starting a project edit automatically.

## Accounts in chat

An account owns a budget; a runner uses that account. Explain this only when useful.
Reuse a compatible existing account unless the user requests another one.

For a new Claude/Codex account, ask only for missing provider/name information,
create an isolated managed home through `account.add`, then invoke `account.signin`.
Use its supported terminal handoff; if unavailable, return its exact account-scoped
command for the user to run. Do not change the default agent login or copy native
credentials. A duplicate name reuses the existing compatible account only after
checking metadata; incompatible names require a new name, never replacement.

Provider sign-in belongs to the provider interface. OpenCode providers use their
own authentication flow. For custom endpoints, key entry happens in a user-operated
hidden terminal prompt or an existing secure entry surface, outside agent tool
arguments, transcripts and chat. The agent consumes only sanitized status; if no
secure surface exists, present the user-operated command and wait. Never ask users
to paste a key into chat. Existing endpoint storage policies remain unchanged.

After sign-in, refresh account status, attach/create the appropriate runner and
make it eligible for routing through supported operations. A login-file indication
is preliminary evidence; an executor test proves execution. Unknown or delayed
budget telemetry is reported separately and does not invent remaining quota.
Failed or canceled sign-in preserves configuration in a needs-sign-in state.
Failed tests retain the account with a repair path and do not label it verified.

The current planner remains in its current account. An explicit planner switch
uses the existing integration transaction and requires a new planner session.
Cursor/agy account limitations remain those in `docs/accounts.md`; do not promise
isolated secondary native accounts for tools that support only default accounts.

## Structured workflow and architecture

Reuse `setup.check`, `setup.init`, `agent.preview`, `agent.connect`, `service.install`,
`account.add`, `account.signin`, runner operations, `doctor.run`, `onboarding.try`
and task/review operations wherever suitable. Inspect the actual CLI and protocol
surface before specifying public command syntax. CLI and app remain complete clients.

Add an additive onboarding workflow contract through the versioned operation registry
before clients. Provide structured inspection and action results with the current
revision, relevant setup facts, next supported action, required consent, sanitized
handoff details, blockers and verification evidence. Avoid unrestricted command
strings as executable instructions; provider actions use validated adapter argv.
Exact operation names, schemas and CLI spelling are left to implementation planning.

The service owns setup state and shared decisions. Before the service exists, the
guide handles only installation and starting the supported local service boundary;
it then hands control to API operations. Reuse the repository's existing bootstrap
path, and resolve any required bootstrap changes explicitly in the implementation plan.
Provider-specific installation/authentication behavior belongs behind existing adapters
or plugins, consistent with ARCH-12, rather than hard-coded planner branches in core.

Recompute readiness from current facts on resume; persisted progress is not proof.
Persist only minimal nonsecret checkpoint and evidence references where existing
state cannot represent them. Writes are atomic and restrictive. Mutating actions
use revision/precondition checks and existing mutation boundaries. A stale preview
returns conflict and requires a refreshed preview/consent. Repeated calls reuse the
same in-flight handoff/test where applicable; never create duplicate accounts or
delegations on retry. Bound status polling; resume canceled/expired handoffs through
an explicit retry. Events and inspection let both app and agent reflect changes.

Keep existing `complete`/`ready` fields compatible. Add explicit verification facts
instead of changing their meaning: configured, awaiting user action, blocked,
execution verified, practice skipped, and integration invocation unverified as
applicable. Skipping the practice remains available, but never yields a claim of
verified first delegation. Whole-onboarding success requires the practice to pass
and be reviewed; users may continue with a clearly qualified skipped state.

## Recovery

- Existing partial setup: inspect and continue the earliest unmet prerequisite.
- No executor: offer a supported existing tool or guide one selected installation.
- Terminal unavailable: provide one account-scoped command; resume after user action.
- Authentication canceled/expired: retain account, offer retry, and avoid repeated windows.
- Config edited elsewhere: refresh state and preview; never overwrite concurrent edits.
- Network/install failure: report the failed step and retry without repeating completed work.
- Test failure: preserve evidence and repair guidance; no automatic endless paid retries.
- Guide fetch unavailable: provide a clear blocker and an official documentation fallback.

## Acceptance and validation

Implementation must demonstrate fresh and partial installation, rerun without duplicate
side effects, new isolated Codex/Claude account, existing account reuse, canceled login,
terminal fallback, provider/key handoff, conflicting configuration changes, failed test,
skipped practice, and successful delegation plus independent planner acceptance.
Exercise at least two supported planner adapters to check neutrality. Verify newly
installed integration invocation separately, including the new-session case.

Tests cover workflow transitions, concurrent/stale actions, duplicate prevention,
sanitized results, and compatibility of existing setup fields. UI changes use shared
design-system controls and existing accessibility/evidence requirements. Run applicable
checks and `bun run live` under CT-11; report unsupported platform/provider/native
surfaces as UNVERIFIED. Validate secret handling with synthetic credentials only.

Update installation/accounts/CLI/app docs, generated protocol docs if changed, and
CHANGELOG when behavior ships. Record a numbered ADR for the durable workflow
contract before delivering implementation, following the current AGENTS.md naming.

## Governance and approval boundary

Context: constitution 0.13.0; `.project/context.md` and `.project/decisions.md`.
Applicable established constraints: ARCH-1–5/8–9/12–14, API-1–6, SEC-1–5/7,
REPO-1–7; CT-11 and UI rules apply when runtime/UI work is implemented.
REPO-10 independent review is required by the session's AGENTS.md instructions.
Canonical rules live under `.project/rules/`; architecture/security reviewer criteria
under `.project/reviewers/`. Proposed governance amendments are not silently adopted.
No policy exception is requested. ADR naming remains an existing governance conflict;
the explicit numbered convention is used for any new implementation ADR.

This is a multi-surface feature. Approving this document authorizes implementation
planning next; it does not assert that onboarding is implemented or live-validated.

# Startup setup health

Date: 2026-11-06. Status: approved for implementation (@lamtuanvu). Applies to: desktop shell connect path, web app entry after service ready, `doctor.run` / setup readiness, post-update verification, Settings → Diagnostics and Setup attention. Related: [guided onboarding](2026-10-19-guided-onboarding-design.md), [desktop-first onboarding](2026-10-19-desktop-first-onboarding-design.md), [agentic onboarding](2026-10-24-agentic-onboarding-design.md).

## Intent

Pacer’s job is to admit AI coding work through itself: detect agents, wire hooks/integrations, pace budgets, and supervise delegation. Users currently see a slow or opaque startup and then an empty Dispatch, and reasonably blame the app. Startup must run a **named setup health pass**, show clear progress, and leave either a ready state or actionable fixes — never a silent wait.

## Goals

- Separate **Connecting to service** from **Checking setup** in the UI.
- On every cold start (and after every update), run a bounded setup health pass and show it as a full-window stage before Dispatch when checks are in progress or hard-failed.
- Map doctor outcomes to human steps with live status (`waiting` / `running` / `passed` / `needs attention` / `failed`).
- Offer **Fix** actions for known, safe repairs (reconnect drifted integrations, clear mismatched planner config dir when owned, refresh limits); require consent for destructive or identity-changing steps.
- Persist last-pass fingerprint (app/service version + integration hashes) so “Setup OK · checked just now” is honest.
- Keep Diagnostics as the deep report; startup UI is the summary + actions.

## Non-goals

- Replacing the full `doctor` corpus on the gate (no removable-volume tour on every start).
- Silently overwriting user-customized hook files without preserve/reconnect flow.
- Installing every possible agent CLI automatically.
- Treating budget exhaustion as a setup failure.
- Claiming live hook enforcement from file presence alone (configured ≠ firing).

## Anti-goals

- Blank shell or spinner-only “Starting pacer…” with no named work.
- Blocking forever on a slow provider usage probe.
- Entering Dispatch green while planner hooks or service health are known-broken.

## Phases (UI)

### 1. Connecting to service

Existing desktop/web connect path. Copy stays about the local service (starting, signing in, waiting). Do not mix agent checks here.

### 2. Checking setup (new)

Full-window stage once the service is ready (or immediately after update before treating the install as ready).

- Title: **Checking setup**
- Support line: *Making sure agents can work through pacer.*
- After update, eyebrow: **After update · checking setup**
- Step list (fixed order; omit a step only when inapplicable):

| Step | Meaning |
| --- | --- |
| Service ready | Already satisfied when this stage opens; shown as passed for orientation |
| Detect agents | Which planner/executor CLIs are present |
| Integrations & hooks | Managed install freshness for Claude / Codex / Cursor / OpenCode |
| Usage & eligibility | Bounded refresh; at least one non-planner path that can take work, or an honest “none ready” |
| Ready to take work | Aggregate: admission wiring OK enough to enter the app |

- Progress: determinate N of M when possible; when a step exceeds ~2s, show its active detail (“Refreshing Codex usage…”).
- Per-step timeout: mark **Needs attention** or **Failed**; never hang the stage indefinitely.

### 3. Outcomes

| Result | Behavior |
| --- | --- |
| All required steps passed | Enter app; quiet chrome: **Setup OK · checked just now** (status strip or Overview) |
| Warnings only | Enter app; persistent **Setup** attention chip with count (“2 fixes recommended”) linking to Setup/Diagnostics |
| Hard fail (no service identity, no planner wiring when a planner is selected, etc.) | Stay on the gate with **Fix**, **Open Diagnostics**, **Continue anyway** |

## Suggest and handle

Known doctor / integration codes map to one primary action:

- Drifted managed hooks → `pacer install <agent>` reconnect preview + apply with consent
- Stale or mismatched `CLAUDE_CONFIG_DIR` / planner account folder (when pacer owns the service env) → repair to the selected account folder and prompt restart if required
- Stale usage where refresh is supported → `limits.refresh`
- Disabled/missing runner when an alternative is ready → enable or point Setup at that runner

Do not auto-install arbitrary third-party CLIs. Do not treat exhausted quota as fixable setup.

Honesty: after file repairs, show **Wiring OK · live enforcement unverified** until a probe or observed guard deny/redirect exists (same honesty rule as Diagnostics).

## Triggers

- Desktop/web: after successful service session, before treating the shell as ready for normal navigation (skip the full-window stage only when a fresh fingerprint matches and no attention remains — still allow a quiet background recheck).
- After CLI or desktop update / service restart that changes binary or integration generation: force the full-window stage with the after-update eyebrow.
- Manual: Settings → Diagnostics remains; Setup attention chip re-opens the summary.

## API / persistence (builder scope)

Prefer extending existing `doctor.run` / `setup.check` rather than a parallel corpus:

- A **setup-health** view-model (or op) that returns the fixed step list, per-step state, and repair descriptors already used by Diagnostics where possible.
- Persist under `$PACER_HOME` a last-pass record: checkedAt, duration, app/service versions, step verdicts, integration content hashes, attention count.
- Fingerprint invalidation on version bump or managed-file drift.

Exact op names and schemas are left to the implementer under P1/P4 (add capability to the core, expose as operation; additive fields).

## Surfaces

- Desktop Tauri shell and web `/app/` share the same Checking setup stage (thin clients of the API).
- Tray/TUI: not required for v1; report UNVERIFIED if not shipped. Status line may show setup attention count when the API exposes it.
- First-run agent detection + install still composes with existing Setup / onboarding specs; this design owns **continuous readiness indication**, not the full first-account wizard copy.

## Accessibility and UI rules

- Stage is a single composition: brand/product context, one title, one support line, the step list, one CTA group.
- Step updates use polite live regions; failures use `role="alert"` only for hard fail.
- Primary actions are real buttons with visible labels (Fix, Open Diagnostics, Continue anyway).
- Follow UI readiness (UI-18) for light/dark and the shipping widths when the stage ships.

## Evidence

- Unit/view-model tests for step aggregation, timeouts, fingerprint skip/force-after-update.
- Live: cold start shows Checking setup with progressing steps; after-update eyebrow; warning path leaves attention chip; hard fail stays on gate. Record desktop/web; tray/TUI UNVERIFIED if untouched.

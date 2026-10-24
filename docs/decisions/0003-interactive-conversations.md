# Persistent interactive conversations

Date: 2026-10-22. Status: approved design; implementation validation pending.

Pacer's primary entry creates a conversation backed by the existing task store and detached PTY. An explicit per-task interaction mode separates ongoing conversation activity from finite delegated task completion. Missing mode fields retain delegated behavior. Turns, reports and viewer disconnects leave conversations running; explicit stop and process exit end them without inferring acceptance or integration.

The host owns lifecycle, workspace admission, private attachment storage and terminal control. A bundled `agentSession` plugin prepares agent-specific argument vectors and attachment references through the versioned plugin protocol. It receives no credentials and needs no process or filesystem grants. Once selected, agent/account identity stays fixed. Unsupported mechanisms return reasons rather than invoking a built-in fallback.

The application reuses xterm.js and the authenticated session transport. Native terminal behavior is preserved. Clipboard image bytes travel through a separate private upload pipeline; reference insertion requires an explicit user action and never submits a prompt.

Historical initial adapter evidence came from installed CLI help for codex-cli 0.163.0, Claude Code 2.1.281 and OpenCode 2.1.2. Native launch images use Codex's documented `-i`; other file delivery is explicitly labeled a path reference. The initial exact-version gate and OpenCode model restriction are superseded by the implementation described below. Feature support still requires real-agent live evidence.

Primary references: [Codex CLI reference](https://developers.openai.com/codex/cli/reference/), [Claude Code workflows](https://code.claude.com/docs/en/common-workflows), [OpenCode attachments](https://opencode.ai/v2/docs/attachments/). Product scope: [interactive entry spec](../specs/2026-10-21-interactive-entry-design.md).

This is additive to the service and plugin contracts. It grants no governance exception. Applicable architecture, API, security, UI and CT-11 rules remain in force.


## Expanded native adapter support

The approved [three-agent support design](../specs/2026-10-24-interactive-agent-support-design.md) completes Claude Code, Codex and OpenCode support within the existing native-terminal architecture. Installed CLI interface probes replace exact-version eligibility. The plugin supplies native launch/resume arguments, identity allocation/recovery plans and OpenCode reporting source; the host executes those plans in the selected account/workspace, materializes private reporting artifacts and persists state. No native credentials enter plugin inputs.

Claude assigns a fresh UUID through its native session option. OpenCode uses its standalone native API to create a specific session with the chosen model and verify existing history before resume. Per-run native event reporting records activity without submitting terminal input. Conversation selection includes the planner account while delegation keeps its exclusion; project, account, budget and slot guardrails remain effective. Session creation accepts configured named executor IDs. Live coverage and provider limitations are recorded separately in the change's evidence report; implementation support is not a claim that every provider, CLI release or platform passed live validation.

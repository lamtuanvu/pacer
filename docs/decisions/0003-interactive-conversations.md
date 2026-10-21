# Persistent interactive conversations

Date: 2026-10-22. Status: approved design; implementation validation pending.

Pacer's primary entry creates a conversation backed by the existing task store and detached PTY. An explicit per-task interaction mode separates ongoing conversation activity from finite delegated task completion. Missing mode fields retain delegated behavior. Turns, reports and viewer disconnects leave conversations running; explicit stop and process exit end them without inferring acceptance or integration.

The host owns lifecycle, workspace admission, private attachment storage and terminal control. A bundled `agentSession` plugin prepares agent-specific argument vectors and attachment references through the versioned plugin protocol. It receives no credentials and needs no process or filesystem grants. Once selected, agent/account identity stays fixed. Unsupported mechanisms return reasons rather than invoking a built-in fallback.

The application reuses xterm.js and the authenticated session transport. Native terminal behavior is preserved. Clipboard image bytes travel through a separate private upload pipeline; reference insertion requires an explicit user action and never submits a prompt.

Initial adapter evidence comes from installed CLI help for codex-cli 0.163.0, Claude Code 2.1.281 and OpenCode 2.1.2. Native launch images use Codex's documented `-i`; other file delivery is explicitly labeled a path reference. OpenCode interactive model overrides remain unsupported until a native mechanism is verified. Feature support still requires real-agent live evidence.

Primary references: [Codex CLI reference](https://developers.openai.com/codex/cli/reference/), [Claude Code workflows](https://code.claude.com/docs/en/common-workflows), [OpenCode attachments](https://opencode.ai/v2/docs/attachments/). Product scope: [interactive entry spec](../specs/2026-10-21-interactive-entry-design.md).

This is additive to the service and plugin contracts. It grants no governance exception. Applicable architecture, API, security, UI and CT-11 rules remain in force.

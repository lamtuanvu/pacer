import { validateStrategy } from "../../src/config/strategy";

/**
 * Two equal-capacity local executors (max_tasks: 3) in one band under priority: codex first in
 * the policy order. Endpoints resolve as `opencode#tse` with a provider/model declaration.
 */
export const pairStrategy = (balance: "off" | "least-loaded") => validateStrategy({
  planner: "claude-code",
  accounts: { "claude-code": { kind: "claude" }, codex: { kind: "codex" }, tse: { kind: "endpoint", usage: "quota", quota_source: "arkcli" } },
  runners: { codex: { max_tasks: 3 }, "opencode#tse": { model: "go/t", max_tasks: 3 } },
  pacing: { policy: "priority", order: ["codex", "opencode#tse"], balance },
  routing: [{ default: ["codex", "opencode#tse"] }],
}, "/x");

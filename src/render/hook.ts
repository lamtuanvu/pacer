import type { Status } from "../engine/status";
import { renderText } from "./text";

const OFF = "pacer delegation policy is OFF for this session (PACER=off). Do the work directly.";

/** Session-start output for a planner: Claude Code gets hook JSON, others plain text. */
export function renderHook(st: Status, planner: string): string {
  const body = st.disabled ? OFF : `Subscription budget status (pacer):\n${renderText(st)}`;
  if (planner === "claude-code") {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: body } });
  }
  return body;
}

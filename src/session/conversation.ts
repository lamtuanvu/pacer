import type { ConversationActivity } from "../tasks/types";
import type { RunState } from "../supervisor/run";

/** Agent activity is independent of whether anyone is viewing the PTY. */
export function conversationActivity(state: RunState): ConversationActivity {
  if (state.exit !== null || !state.alive) return "ended";
  switch (state.report?.status) {
    case "needs-input": return "waiting";
    case "turn-ended":
    case "done":
    case "failed": return "idle";
    case "running": return "working";
    default: return state.lastOutputAt === null ? "starting" : "working";
  }
}

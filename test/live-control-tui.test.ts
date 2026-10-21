import { expect, test } from "bun:test";
import { createTuiAdapter } from "../scripts/live/control/tui";
import { dispatch } from "../scripts/live/control/dispatch";
import type { Session } from "../scripts/live/core";
test("TUI adapter advertises text capture and refuses clicks", async () => {
  const adapter = createTuiAdapter({ id: "contract" } as Session);
  const result = await dispatch({ command: "act", surface: "tui", action: { kind: "click", x: 1, y: 1, capture_id: "image" } }, adapter);
  expect(result.error?.code).toBe("unsupported_capability");
});

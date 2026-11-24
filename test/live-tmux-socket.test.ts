import { expect, test } from "bun:test";
import { liveTmuxArgs, liveTmuxSocket } from "../scripts/live/tmux-socket";

test("live TUI uses a private tmux socket named for the sandbox id", () => {
  expect(liveTmuxSocket("wf-p8s")).toBe("pacer-live-wf-p8s");
  expect(liveTmuxArgs("wf-p8s", ["has-session", "-t", "pacer-live-wf-p8s"])).toEqual([
    "-L", "pacer-live-wf-p8s", "has-session", "-t", "pacer-live-wf-p8s",
  ]);
  expect(liveTmuxArgs("wf-p8s", ["kill-server"])[0]).toBe("-L");
  expect(liveTmuxArgs("wf-p8s", ["kill-server"])[1]).toBe("pacer-live-wf-p8s");
});

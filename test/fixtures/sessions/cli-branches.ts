/** Isolated module mocks characterize CLI dispatch after real domain outcomes. */
import { mock } from "bun:test";
import * as service from "../../../src/session/service";
import * as attach from "../../../src/session/attach";
import * as takeover from "../../../src/session/takeover";
import { fakeCtx } from "../../helpers";
let state = "driving",
  host = "builtin",
  opened = true;
let calls: unknown[] = [];
mock.module("../../../src/session/takeover", () => ({
  ...takeover,
  takeoverTask: async (_ctx: unknown, id: string) => {
    calls.push(["takeover", id]);
    return { state, attach: { cli: `pacer attach ${id} --control` } };
  },
}));
mock.module("../../../src/session/service", () => ({
  ...service,
  sessionInfo: async () => ({ host }),
  openSession: async (_ctx: unknown, id: string, target: string) => {
    calls.push(["open", id, target]);
    return { opened, command: `pacer attach ${id}` };
  },
}));
mock.module("../../../src/session/attach", () => ({
  ...attach,
  attachDirectory: (_ctx: unknown, id: string, attempt?: number) => {
    calls.push(["directory", id, attempt ?? null]);
    return "fixture-run";
  },
  attachSession: async (dir: string, opts: unknown, label: string) => {
    calls.push(["attach", dir, opts, label]);
  },
}));
const { main } = await import("../../../src/cli");
const rows = [];
for (const scenario of [
  "takeover-no-attach",
  "takeover-starting",
  "takeover-ended",
  "takeover-driving",
  "takeover-executor",
  "attach-executor",
  "attach-orca",
  "attach-orca-gone",
  "attach-open",
  "attach-open-failed",
  "attach-control",
  "attach-replay-attempt",
  "attach-read-only",
]) {
  state =
    scenario === "takeover-starting"
      ? "starting"
      : scenario === "takeover-ended"
        ? "ended"
        : "driving";
  host = scenario.startsWith("attach-orca") ? "orca" : "builtin";
  opened = !["attach-orca-gone", "attach-open-failed"].includes(scenario);
  calls = [];
  const args = scenario.startsWith("takeover")
    ? [
        "takeover",
        "task",
        ...(scenario === "takeover-no-attach" ? ["--no-attach"] : []),
      ]
    : [
        "attach",
        "task",
        ...(scenario.startsWith("attach-open")
          ? ["--open", "terminal"]
          : scenario === "attach-control"
            ? ["--control", "--force"]
            : scenario === "attach-replay-attempt"
              ? ["--replay", "--attempt", "2"]
              : scenario === "attach-read-only"
                ? ["--read-only"]
                : []),
      ];
  rows.push({
    scenario,
    args,
    result: await main(
      args,
      fakeCtx({
        env: scenario.endsWith("executor") ? { PACER_ROLE: "executor" } : {},
      }),
    ),
    calls,
  });
}
process.stdout.write(JSON.stringify(rows));

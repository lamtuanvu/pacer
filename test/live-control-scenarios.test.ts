import { expect, test } from "bun:test";
import { runScenario, scenarioSchema } from "../scripts/live/control/scenarios";
import type { ControlResult } from "../scripts/live/control/contract";
const result: ControlResult = { schema_version: 1, command_id: "one", command: "assert", started_at: "now", finished_at: "now", outcome: "ok", verdict: "PASS", artifacts: [] };
test("scenario validates schema and stops after failure without repeating actions", async () => {
  expect(() => scenarioSchema.parse({ schema_version: 2, name: "bad", steps: [] })).toThrow();
  expect(() => scenarioSchema.parse({ schema_version: 1, name: "bad", steps: [{ command: "shell", surface: "web" }] })).toThrow();
  let calls = 0;
  const summary = await runScenario({ schema_version: 1, name: "fail", steps: [ { command: "assert", surface: "web", condition: { text: "Ready" } }, { command: "act", surface: "web", action: { kind: "key", key: "Tab" } } ] }, async () => { calls++; return { ...result, outcome: "error", verdict: "FAIL" }; });
  expect(calls).toBe(1); expect(summary.verdict).toBe("FAIL");
});
test("commands without assertions cannot certify a scenario", async () => {
  const summary = await runScenario({ schema_version: 1, name: "capture", steps: [{ command: "capture", surface: "web" }] }, async () => ({ ...result, command: "capture", verdict: undefined }));
  expect(summary.verdict).toBe("UNVERIFIED");
});

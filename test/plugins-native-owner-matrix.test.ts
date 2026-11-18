import { expect, test } from "bun:test";
import { front } from "./native-plugin-door";
import { useMatrixRoot, FLAG_ON_DOCTOR_ADDITIONS, KNOWN_REFUSED, PLANNER_STORES, type Run, USAGE_STORES, assistant, doctorSetup, endpoints, expectHostSocketReported, expectIdentical, httpForward, httpOff, httpOn, planners, refusal, runModes, usage } from "./plugins-native-owner-matrix-support";

// HTTP consumer rows of the flag-on matrix; the scenarios and modes live in plugins-native-owner-matrix-support.ts.
useMatrixRoot();

test.skipIf(!front)("usage consumers: limits.refresh, account.usage.check, account.list and status parts", async () => {
  const runs = await runModes("usage", [httpOff, httpOn, httpForward], usage, USAGE_STORES);
  for (const run of runs) expect(run.observed["limits.refresh plan"], run.mode.label).toContain('"outcome":"updated"');
  console.log(expectIdentical(runs).join("\n"));
}, 240000);

test.skipIf(!front)("planner consumers: agent.detect, preview, connect, disconnect, onboarding.skip and strategy.build", async () => {
  const runs = await runModes("planners", [httpOff, httpOn, httpForward], planners, PLANNER_STORES);
  console.log(expectIdentical(runs, { "http on": ["doctor.run connected host socket check"] }).join("\n"));
}, 240000);

test.skipIf(!front)("doctor and setup consumers: doctor.run, setup.check and setup.health", async () => {
  const runs = await runModes("doctor", [httpOff, httpOn, httpForward], doctorSetup, ["state/setup-health.json"]);
  expectHostSocketReported(runs);
  console.log(expectIdentical(runs, { "http on": FLAG_ON_DOCTOR_ADDITIONS }).join("\n"));
}, 240000);

let assistantMemo: Promise<Run[]> | undefined;
const assistantRuns = () => assistantMemo ??= runModes("assistant", [httpOff, httpOn, httpForward], assistant);

/** pacer-assistant resolves its endpoint key with capability.secrets.resolve, which Core answers for the owner call. */
test.skipIf(!front)("assistant: flag-off, flag-on and forwarded turns answer from the fixture endpoint", async () => {
  const runs = await assistantRuns();
  for (const run of runs) expect(run.observed["assistant.turn"], run.mode.label).toContain("Fixture answer.");
  console.log(expectIdentical(runs).join("\n"));
}, 240000);

test.skipIf(!front)("PR 4 endpoint shapes: empty-binding launchEnv crosses, credential-bound calls stay refused", async () => {
  const runs = await runModes("endpoints", [httpOff, httpOn, httpForward], endpoints, ["strategy.yaml"]);
  const on = runs.find(run => run.mode === httpOn)!;
  for (const [key, method] of Object.entries(KNOWN_REFUSED)) expect(on.observed[key], key).toContain(refusal(method));
  expect(on.observed["opencode.json"]).not.toBe("<absent>");
  console.log(expectIdentical(runs, { "http on": Object.keys(KNOWN_REFUSED) }).join("\n"));
}, 240000);

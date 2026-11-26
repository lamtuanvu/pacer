import { expect, test } from "bun:test";
import { assistantPacerStubBin } from "./fixtures/assistant-pacer/native-bin";
import { front, stdio } from "./native-plugin-door";
import { useMatrixRoot, FLAG_ON_DOCTOR_ADDITIONS, KNOWN_REFUSED, PLANNER_STORES, type Run, type Scenario, USAGE_STORES, assistant, connectClaude, doctorSetup, endpoints, expectIdentical, planners, refusal, replyText, runModes, stdioAttached, stdioOff, stdioOffServed, stdioOwn, storeBytes, usage } from "./plugins-native-owner-matrix-support";

// Stdio rows of the flag-on matrix: self-owned and attached doors.
useMatrixRoot();

/** Stdio rows: flag-on self-owned against flag-off alone, and flag-on attached against flag-off beside a flag-off serve. */
async function stdioRows(name: string, scenario: Scenario, stores: string[], known: string[] = []) {
  const owned = await runModes(`${name}-owned`, [stdioOff, stdioOwn], scenario, stores);
  const attached = await runModes(`${name}-attached`, [stdioOffServed, stdioAttached], scenario, stores);
  expect(owned[1]!.stderr).toContain("native plugin owner own ");
  expect(attached[1]!.stderr).toContain(`native plugin owner attach ${attached[1]!.stderr.match(/attach (\S+host\.sock)/)?.[1] ?? "<missing>"}`);
  for (const run of [owned[1]!, attached[1]!]) for (const key of known.filter(key => KNOWN_REFUSED[key])) expect(run.observed[key], `${run.mode.label} ${key}`).toContain(refusal(KNOWN_REFUSED[key]!));
  return [
    ...expectIdentical(owned, { [stdioOwn.label]: known }),
    ...expectIdentical(attached, { [stdioAttached.label]: known }),
  ];
}

test.skipIf(!front)("stdio rows: usage consumers self-owned and attached", async () => {
  console.log((await stdioRows("stdio-usage", usage, USAGE_STORES)).join("\n"));
}, 300000);

test.skipIf(!front)("stdio rows: doctor and setup consumers self-owned and attached", async () => {
  console.log((await stdioRows("stdio-doctor", doctorSetup, ["state/setup-health.json"], FLAG_ON_DOCTOR_ADDITIONS)).join("\n"));
}, 300000);

test.skipIf(!front)("stdio rows: planner consumers self-owned and attached", async () => {
  console.log((await stdioRows("stdio-planners", planners, PLANNER_STORES, ["doctor.run connected host socket check"])).join("\n"));
}, 300000);

test.skipIf(!front)("stdio rows: PR 4 endpoint shapes self-owned and attached", async () => {
  console.log((await stdioRows("stdio-endpoints", endpoints, ["strategy.yaml"], Object.keys(KNOWN_REFUSED))).join("\n"));
}, 300000);

test.skipIf(!front)("stdio rows: assistant turns answer self-owned and attached", async () => {
  // The native reply plugin reaches the doors through the environment passthrough; every
  // mode in this row (including the attached serve) must start with the same stub binary.
  const replyEnv = { PACER_ASSISTANT_PACER_BIN: assistantPacerStubBin };
  const owned = await runModes("stdio-assistant-owned", [stdioOff, stdioOwn], assistant, [], replyEnv);
  const attached = await runModes("stdio-assistant-attached", [stdioOffServed, stdioAttached], assistant, [], replyEnv);
  for (const run of [...owned, ...attached]) expect(run.observed["assistant.turn"], run.mode.label).toContain('"answer":"Fixture answer."');
  console.log([...expectIdentical(owned), ...expectIdentical(attached)].join("\n"));
}, 300000);

const reconnect: Scenario = async (door, h, observe) => {
  observe("agent.connect", replyText(h, await connectClaude(door)));
  observe("agent.connect again", replyText(h, await connectClaude(door)));
  observe("manifest after reconnect", storeBytes(h, "install-manifest.json"));
};
let stdioReconnectMemo: Promise<Run[]> | undefined;
const stdioReconnectRuns = () => stdioReconnectMemo ??= (async () => [
  ...await runModes("stdio-reconnect-owned", [stdioOff, stdioOwn], reconnect),
  ...await runModes("stdio-reconnect-attached", [stdioOffServed, stdioAttached], reconnect),
])();

test.skipIf(!front)("stdio rows: planner reconnect matches flag-off", async () => {
  const runs = await stdioReconnectRuns();
  console.log([...expectIdentical(runs.slice(0, 2)), ...expectIdentical(runs.slice(2))].join("\n"));
}, 300000);

test.skipIf(!front)("flag-on stdio planner reconnect keeps install-manifest.json key order", async () => {
  const runs = await stdioReconnectRuns();
  expect(runs[1]!.observed["manifest after reconnect"]).toBe(runs[0]!.observed["manifest after reconnect"]);
  expect(runs[3]!.observed["manifest after reconnect"]).toBe(runs[2]!.observed["manifest after reconnect"]);
}, 300000);

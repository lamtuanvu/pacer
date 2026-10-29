import { expect, test } from "bun:test";
import { assertSameControlBinding, proveOtaControlBinding, type OtaControlEvidence } from "../scripts/live/control/ota-binding-proof";

import { fixture, hash } from "./fixtures/live/ota-control-evidence";
const desktop = { pid: 4321, bootId: "boot", birth: "100:200" };
test("completed OTA proof yields only ephemeral control identity and preserves input", () => {
  const evidence = fixture(), before = JSON.stringify(evidence);
  expect(() => proveOtaControlBinding(evidence)).not.toThrow();
  const binding = proveOtaControlBinding(evidence);
  expect(binding.identity).toEqual(evidence.identity!);
  expect(binding.appSha256).toBe(hash);
  expect(JSON.stringify(binding.windows)).toBe(JSON.stringify(evidence.captures));
  expect(binding).not.toHaveProperty("desktopPid");
  expect(binding).not.toHaveProperty("desktopIdentity");
  expect(JSON.stringify(evidence)).toBe(before);
});
const cases: [string, (e: any) => void][] = [
  ["active exercise", e => e.state.exercise.state = "running"],
  ["failed exercise", e => e.state.exercise.state = "failed"],
  ["restored journal", e => e.transaction.journal.state = "restored"],
  ["adoption", e => e.state.exercise.scenario = "adopt"],
  ["attached", e => e.transaction.command.target.ownership = "attached"],
  ["active request", e => e.state.runtime.request = {}],
  ["retired runtime", e => e.state.runtime.state = "retired"],
  ["no compiled lease", e => e.state.nativeFixture = null],
  ["unprepared lease", e => e.state.phase = "building"],
  ["no authorization", e => e.transaction.authorization = null],
  ["wrong installation", e => e.transaction.command.installationId = "other"],
  ["wrong transaction", e => e.transaction.record.transactionId = "other"],
  ["pending record", e => e.transaction.record.phase = "installing"],
  ["wrong app", e => e.transaction.command.target.appPath += "-foreign"],
  ["wrong home", e => e.transaction.command.target.pacerHome += "-foreign"],
  ["wrong version", e => e.transaction.journal.verificationProof.desktopVersion = "0.2.3"],
  ["manifest mismatch", e => e.transaction.journal.manifestSha256 = "b".repeat(64)],
  ["wrong readiness session", e => e.transaction.journal.verificationProof.installationId = "other"],
  ["invalid readiness", e => e.transaction.journal.verificationProof.desktopSignedIn = false],
  ["no release", e => e.transaction.journal.steps.shift()],
  ["recovery loaded", e => e.jobs.jobs[1].loaded = true],
  ["foreign job", e => e.jobs.jobs[1].label = "foreign"],
  ["duplicate job", e => e.jobs.jobs.push(e.jobs.jobs[0])],
  ["duplicate desktop", e => e.jobs.desktops.push(e.jobs.desktops[0])],
  ["reused desktop pid", e => e.jobs.desktops[0] = { ...desktop, birth: "new" }],
  ["wrong service", e => e.jobs.jobs[0].process = desktop],
  ["foreign registration", e => e.jobs.jobs[0].registrationSha256 = "b".repeat(64)],
  ["retired service ledger", e => e.state.registrations[0].state = "retired"],
  ["unknown service incarnation", e => e.state.registrations[0].processes = []],
  ["foreign desktop executable", e => e.processes[0].executable += "-foreign"],
  ["unknown OS incarnation", e => e.processes[0].process = { ...desktop, birth: "new" }],
  ["missing control identity", e => e.identity = null],
  ["different control PID", e => e.identity.pid++],
  ["different control birth", e => e.identity.start_identity = "new"],
  ["invalid image hash", e => e.appSha256 = ""],
  ["no capture worker", e => e.captures = []],
  ["wrong capture PID", e => e.captures[0].pid++],
  ["duplicate window", e => e.captures.push(e.captures[0])],
  ["duplicate label", e => e.captures.push({ ...e.captures[0], window_id: "456" })],
  ["multiple worker clients", e => e.captures.push({ ...e.captures[0], window_id: "456", label: "tray", client_id: "other" })],
  ["unknown client", e => e.clients = []],
  ["wrong client version", e => e.clients[0].version = "0.2.3"],
  ["non-desktop client", e => e.clients[0].kind = "app"],
  ["unknown capture fields", e => e.captures[0].authority = true],
];
for (const [name, mutate] of cases) test(`refuses ${name}`, () => {
  const evidence = fixture(); mutate(evidence);
  expect(() => proveOtaControlBinding(evidence)).toThrow();
});

test("a fresh observation detects restart, image, transaction and capture worker replacement", () => {
  const before = proveOtaControlBinding(fixture());
  const replacements = [
    { ...before, identity: { ...before.identity, start_identity: "new" } },
    { ...before, appSha256: "b".repeat(64) },
    { ...before, transactionId: "next" },
    { ...before, installationId: "other" },
    { ...before, source: "ordinary" as const },
    { ...before, windows: before.windows!.map(w => ({ ...w, client_id: "replacement" })) },
  ];
  for (const after of replacements) expect(() => assertSameControlBinding(before, after)).toThrow("authority changed");
  expect(() => assertSameControlBinding(before, proveOtaControlBinding(fixture()))).not.toThrow();
});
test("a fresh window list may update without transferring process authority", () => {
  const before = proveOtaControlBinding(fixture());
  const evidence = fixture();
  (evidence.captures as any[])[0].window_id = "789";
  const after = proveOtaControlBinding(evidence);
  expect(() => assertSameControlBinding(before, after)).not.toThrow();
  expect(after.windows![0].window_id).toBe("789");
});

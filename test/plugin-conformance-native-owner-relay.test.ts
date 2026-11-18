import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, type CaseContext, type ConformanceCase } from "../conformance/cases";
import { runCase } from "../conformance/run";
import { front } from "./native-plugin-door";
import { conformanceRoot, cases, coreDoctor, doctor, doors, tsDoor } from "./plugin-conformance-native-owner-support";

// Capability relay, plugin log and identity.sign parity between the native owner doors and the TypeScript host.

const root = conformanceRoot();

// Capabilities relayed from a plugin child during a diagnostic ping. A ping issues no read, write,
// spawn or HTTP resources, so the TypeScript host refuses each scoped capability and nothing reaches
// the filesystem, a process or the network; config.get answers.
type Outcome = { ok: boolean; error: string | null; result: unknown };
let outcome: Outcome | undefined;
let httpHits = 0;
const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { httpHits++; return new Response("{}"); } });
afterAll(() => listener.stop(true));

function relayCase(label: string, capability: string, declared: string[] | ((home: string) => string[]), method: string, params: (home: string) => Record<string, unknown>): ConformanceCase {
  return { name: `capability relay: ${label}`, async run(t: CaseContext) {
    mkdirSync(join(t.home, "data"), { recursive: true });
    writeFileSync(join(t.home, "data", "x.txt"), "fixture\n");
    const scopes = typeof declared === "function" ? declared(t.home) : declared;
    const dir = t.install("good", { manifest: { id: "fx-relay", host: "^1.6", capabilities: [{ name: "log" }, { name: capability, ...(scopes.length ? { scopes } : {}) }] }, fixture: { callCapability: method, capabilityParams: params(t.home), capabilityResultFile: "capability-result.json" } });
    const h = await t.host();
    await h.call("plugin.enable", { id: "fx-relay", grant: true });
    const report = await doctor(h, "fx-relay");
    const resultFile = join(dir, "capability-result.json");
    outcome = { ok: report.ok, error: report.error?.replaceAll(t.home, "<HOME>") ?? null, result: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null };
    assert(!existsSync(join(t.home, "out", "x.txt")), "nothing is written");
  } };
}

const RELAY: [ConformanceCase, string | null][] = [
  [relayCase("config.get", "config.get", [], "config.get", () => ({})), null],
  [relayCase("fs.read", "fs.read", ["${HOME}/data/**"], "fs.read", home => ({ path: join(home, "data", "x.txt") })), null],
  [relayCase("fs.read exact path", "fs.read", home => [join(home, "data", "x.txt")], "fs.read", home => ({ path: join(home, "data", "x.txt") })), null],
  [relayCase("fs.write", "fs.write", ["${HOME}/out/**"], "fs.write", home => ({ path: join(home, "out", "x.txt"), text: "written" })), null],
  [relayCase("fs.beginWrite transfer", "fs.write", ["${HOME}/out/**"], "fs.beginWrite", home => ({ path: join(home, "out", "x.txt"), bytes: 7 })), null],
  [relayCase("process.spawn", "process.spawn", ["fx-tool"], "process.spawn", () => ({ argv: ["fx-tool"], timeoutMs: 1000 })), null],
  [relayCase("net.http", "net.http", ["127.0.0.1"], "net.http", () => ({ url: `http://127.0.0.1:${listener.port}/`, method: "GET", timeoutMs: 2000 })), null],
];

for (const [c, reason] of RELAY) {
  cases(reason)(`native owner conformance: ${c.name} matches the TypeScript host${reason ? ` [${reason.split(":")[0]}]` : ""}`, async () => {
    const seen: Record<string, Outcome> = {}, hits: Record<string, number> = {};
    for (const { label, argv, door } of [tsDoor, ...doors]) {
      outcome = undefined;
      const before = httpHits;
      await runCase(c, argv, root, door);
      seen[label] = outcome!;
      hits[label] = httpHits - before;
    }
    console.log(`${c.name}: ${JSON.stringify({ seen, hits })}`);
    expect(seen.typescript!.ok).toBe(c.name === "capability relay: config.get");
    expect(Object.fromEntries(doors.map(({ label }) => [label, { outcome: seen[label], hits: hits[label] }])))
      .toEqual(Object.fromEntries(doors.map(({ label }) => [label, { outcome: seen.typescript, hits: 0 }])));
  }, 90000);
}

// A diagnostic ping writes stderr covering the TypeScript log rules: `\r` stripped, empty lines kept,
// the 4096 UTF-16 unit cut (a surrogate pair cut in half becomes U+FFFD) and a dropped line over 1 MiB.
const STDERR_TEXT = ["crlf\r", "", "é😀 text", `${"x".repeat(4095)}😀tail`, "y".repeat(5000), "z".repeat(1024 * 1024 + 1), "end"].map(line => `${line}\n`).join("");
let logLines: string[] = [];
const stderrLogCase: ConformanceCase = { name: "plugin log: every stderr line in the TypeScript format", async run(t) {
  t.install("good", { fixture: { pingStderr: STDERR_TEXT } });
  const h = await t.host();
  await h.call("plugin.enable", { id: "fx-good", grant: true });
  assert((await doctor(h, "fx-good")).ok, "ping ok");
  const log = join(t.home, ".pacer", "logs", "plugins", "fx-good.log");
  const read = () => existsSync(log) ? readFileSync(log, "utf8") : "";
  for (const end = Date.now() + 5000; Date.now() < end && !read().includes("] end\n");) await t.sleep(20);
  logLines = read().split("\n").map(line => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /, "<time> "));
} };

(front ? test : test.skip)("native owner conformance: stderr log lines match the TypeScript host", async () => {
  const seen: Record<string, string[]> = {};
  for (const { label, argv, door } of [tsDoor, ...doors]) {
    logLines = [];
    await runCase(stderrLogCase, argv, root, door);
    seen[label] = logLines;
  }
  expect(seen.typescript).toContain("<time> [stderr] end");
  expect(seen.typescript).toContain("<time> [stderr] dropped a line over 1 MiB");
  for (const { label } of doors) expect({ label, lines: seen[label] }).toEqual({ label, lines: seen.typescript! });
}, 90000);

// A diagnostic ping also writes malformed and over-1-MiB lines to stdout: the transport drops
// each with the same note (as `[stderr]`) the TypeScript host writes to the plugin log.
const TRANSPORT_TEXT = "this is not valid json\r\n" + "z".repeat(1024 * 1024 + 1) + "\n";
let transportLines: string[] = [];
const stdoutTransportCase: ConformanceCase = { name: "plugin log: malformed and oversized stdout lines get the TypeScript notes", async run(t) {
  t.install("good", { fixture: { pingStdout: TRANSPORT_TEXT } });
  const h = await t.host();
  await h.call("plugin.enable", { id: "fx-good", grant: true });
  assert((await doctor(h, "fx-good")).ok, "ping ok");
  const log = join(t.home, ".pacer", "logs", "plugins", "fx-good.log");
  const read = () => existsSync(log) ? readFileSync(log, "utf8") : "";
  // The malformed note is a separate blocking-append task on the Rust doors, so it can land
  // after the drop note: wait for both before the one read.
  const both = () => { const text = read(); return text.includes("] dropped a line over 1 MiB\n") && text.includes("ignored a malformed JSON line on stdout"); };
  for (const end = Date.now() + 5000; Date.now() < end && !both();) await t.sleep(20);
  transportLines = read().split("\n")
    .filter(line => line.includes("malformed JSON line on stdout") || line.includes("dropped a line over 1 MiB"))
    .map(line => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /, "<time> "));
} };

(front ? test : test.skip)("native owner conformance: malformed and oversized stdout notes match the TypeScript host", async () => {
  const seen: Record<string, string[]> = {};
  for (const { label, argv, door } of [tsDoor, ...doors]) {
    transportLines = [];
    await runCase(stdoutTransportCase, argv, root, door);
    seen[label] = transportLines;
  }
  expect(seen.typescript).toContain("<time> [stderr] ignored a malformed JSON line on stdout");
  expect(seen.typescript).toContain("<time> [stderr] dropped a line over 1 MiB");
  for (const { label } of doors) expect({ label, lines: seen[label] }).toEqual({ label, lines: seen.typescript! });
}, 90000);

// An undeclared identity.sign during a ping: the TypeScript host refuses it and audits the refusal.
// The owner doors relay their doctor ping through Core's sealed owner call, as a flag-on serve that
// keeps plugin.doctor in Core does, so Core refuses and audits it the same way.
type Signing = { ok: boolean; error: string | null; audit: unknown[] };
let signing: Signing | undefined;
const undeclaredSign: ConformanceCase = { name: "identity.sign undeclared", async run(t) {
  t.install("good", { manifest: { id: "fx-unsigned", host: "^1.6", capabilities: [{ name: "log" }] },
    fixture: { callCapability: "identity.sign", capabilityParams: { purpose: "greeting", payload: Buffer.from("hello").toString("base64") } } });
  const h = await t.host();
  await h.call("plugin.enable", { id: "fx-unsigned", grant: true });
  const report = await doctor(h, "fx-unsigned");
  const audit = join(t.home, ".pacer", "logs", "identity-audit.jsonl");
  signing = { ok: report.ok, error: report.error, audit: existsSync(audit) ? readFileSync(audit, "utf8").trim().split("\n").map(line => {
    const { pluginId, purpose, outcome, reason } = JSON.parse(line);
    return { pluginId, purpose, outcome, reason };
  }) : [] };
} };

cases(null)("native owner conformance: an undeclared identity.sign is refused and audited as on the TypeScript host", async () => {
  const seen: Record<string, Signing> = {};
  for (const { label, argv, door } of [tsDoor, ...coreDoctor, ...doors]) {
    signing = undefined;
    await runCase(undeclaredSign, argv, root, door);
    seen[label] = signing!;
  }
  console.log(`identity.sign undeclared: ${JSON.stringify(seen)}`);
  expect(seen.typescript).toEqual({ ok: false, error: "capability_denied: plugin fx-unsigned did not declare identity.sign",
    audit: [{ pluginId: "fx-unsigned", purpose: "greeting", outcome: "refused", reason: "capability not declared" }] });
  expect(seen["serve owner, Core doctor"]).toEqual(seen.typescript);
  for (const { label } of doors) expect({ label, seen: seen[label] }).toEqual({ label, seen: seen.typescript });
}, 120000);

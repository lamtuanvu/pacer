import { expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, type ConformanceCase } from "../conformance/cases";
import { HostError } from "../conformance/host";
import { runCase } from "../conformance/run";
import { conformanceRoot, cases, coreDoctor, doctor, doors, listed, tsDoor } from "./plugin-conformance-native-owner-support";

// Method deadlines on the native owner doors, compared with the TypeScript host.

const root = conformanceRoot();

// The doors' doctor and UI calls keep each method's flag-off deadline: a ping gets 5 s, which also bounds the
// hello, and a render 2 s. Each delay outlasts the deadline plus the margin, so a later deadline fails the time bound
// too. Each case runs once per host; `call` is the reply and `book` Core's bookkeeping after it.
type Deadline = { afterMs: number; call: unknown; book?: unknown };
let deadline: Deadline | undefined;
const timed = async (call: () => Promise<unknown>) => {
  const started = Date.now();
  const seen = await call().catch(error => error instanceof HostError ? { code: error.code, message: error.message } : Promise.reject(error));
  return { afterMs: Date.now() - started, seen };
};
// Flag-off records whichever of the call's deadline and the hello's own deadline fires first, so the
// crash's error is either wording; both mean the hello missed the call's deadline.
const helloCrash = (error: string | null | undefined) =>
  error === "owning plugin call ended" || /^plugin\.hello passed its \d+ ms deadline$/.test(error ?? "") ? "<the hello missed the call's deadline>" : error;
const DEADLINES: (ConformanceCase & { deadlineMs: number; book?: { name: string; reason: string | null } })[] = [
  { name: "a 7 s hello fails the 5 s doctor ping", deadlineMs: 5000, book: { name: "records a crash", reason: null }, async run(t) {
    t.install("good", { fixture: { startDelayMs: 7000 } });
    const h = await t.host();
    await h.call("plugin.enable", { id: "fx-good", grant: true });
    const { afterMs, seen } = await timed(() => doctor(h, "fx-good"));
    const report = seen as { ok: boolean; error: string | null; restarts: number };
    const entry = (await listed(h)).find(p => p.id === "fx-good") as { error?: string | null };
    deadline = { afterMs, call: { ok: report.ok, error: report.error }, book: { restarts: report.restarts, error: helloCrash(entry.error) } };
  } },
  { name: "a 7 s ping fails the 5 s doctor ping", deadlineMs: 5000, book: { name: "lists the plugin ready", reason: null }, async run(t) {
    t.install("good", { fixture: { pingDelayMs: 7000 } });
    const h = await t.host();
    await h.call("plugin.enable", { id: "fx-good", grant: true });
    const { afterMs, seen } = await timed(() => doctor(h, "fx-good"));
    const report = seen as { ok: boolean; error: string | null; state: string };
    deadline = { afterMs, call: { ok: report.ok, error: report.error }, book: { state: report.state } };
  } },
  { name: "a 4 s render fails the 2 s ui.render", deadlineMs: 2000, async run(t) {
    t.install("ui", { fixture: { renderDelayMs: 4000 } });
    const h = await t.host();
    await h.call("plugin.enable", { id: "fx-ui", grant: true });
    assert((await doctor(h, "fx-ui")).ok, "the plugin starts");
    const { afterMs, seen } = await timed(() => h.call("plugin.ui.render", { plugin: "fx-ui", surface: "status", id: "open-items", context: { route: "overview", theme: "light" } }));
    deadline = { afterMs, call: seen };
  } },
];
const deadlineRuns = new Map<string, Promise<Record<string, Deadline>>>();
const deadlineRun = (c: (typeof DEADLINES)[number]) => deadlineRuns.get(c.name) ?? deadlineRuns.set(c.name, (async () => {
  const seen: Record<string, Deadline> = {};
  for (const { label, argv, door } of [tsDoor, ...doors]) {
    deadline = undefined;
    await runCase(c, argv, root, door);
    seen[label] = deadline!;
  }
  console.log(`${c.name}: ${JSON.stringify(seen)}`);
  return seen;
})()).get(c.name)!;
for (const c of DEADLINES) {
  cases(null)(`native owner conformance: ${c.name} at its deadline with the TypeScript host's text`, async () => {
    const seen = await deadlineRun(c);
    for (const { label } of [tsDoor, ...doors]) {
      expect({ label, call: seen[label]!.call }).toEqual({ label, call: seen.typescript!.call });
      expect(seen[label]!.afterMs, label).toBeGreaterThanOrEqual(c.deadlineMs);
      expect(seen[label]!.afterMs, label).toBeLessThan(c.deadlineMs + 1500);
    }
  }, 120000);
  if (c.book) cases(c.book.reason)(`native owner conformance: ${c.name} and ${c.book.name} as on the TypeScript host${c.book.reason ? ` [${c.book.reason.split(":")[0]}]` : ""}`, async () => {
    const seen = await deadlineRun(c);
    for (const { label } of doors) expect({ label, book: seen[label]!.book }).toEqual({ label, book: seen.typescript!.book });
  }, 120000);
}

// The TypeScript host writes a `capability.log` line when it arrives, so a call that then misses its
// deadline keeps the line; the owner hands the call's lines back with its failure for Core to write.
type Logged = { ok: boolean; error: string | null; logged: boolean };
let logged: Logged | undefined;
const logThenTimeout: ConformanceCase = { name: "capability.log before a timed-out ping", async run(t) {
  t.install("good", { fixture: { callCapability: "log", pingDelayMs: 7000 } });
  const h = await t.host();
  await h.call("plugin.enable", { id: "fx-good", grant: true });
  const report = await doctor(h, "fx-good");
  const log = join(t.home, ".pacer", "logs", "plugins", "fx-good.log");
  const read = () => existsSync(log) && readFileSync(log, "utf8").includes("[info] hello from fixture");
  for (const end = Date.now() + 3000; Date.now() < end && !read();) await t.sleep(50);
  logged = { ok: report.ok, error: report.error, logged: read() };
} };

cases(null)("native owner conformance: a timed-out call keeps its capability.log lines as on the TypeScript host", async () => {
  const seen: Record<string, Logged> = {};
  for (const { label, argv, door } of [tsDoor, ...coreDoctor, ...doors]) {
    logged = undefined;
    await runCase(logThenTimeout, argv, root, door);
    seen[label] = logged!;
  }
  console.log(`capability.log before a timeout: ${JSON.stringify(seen)}`);
  expect(seen.typescript).toEqual({ ok: false, error: "plugin_timeout: plugin call passed its absolute deadline", logged: true });
  for (const { label } of [...coreDoctor, ...doors]) expect({ label, seen: seen[label] }).toEqual({ label, seen: seen.typescript });
}, 120000);

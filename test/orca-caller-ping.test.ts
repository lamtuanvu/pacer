import { expect, test } from "bun:test";
import { pingOrcaCaller } from "../src/exec/orca/caller-ping";
import { type Route, fakeRun, ok, raw } from "./fixtures/orca/fake";
import { fakeCtx } from "./helpers";

const HANDLE = "term_d2540c20-c681-4f80-bc41-689a96ed264a";
const PING = "pacer: task t-1 is done. Review and decide: `pacer review t-1 --accept|--reject`, or `pacer msg inbox`.";
const SHOW = ["orca", "terminal", "show"];
const SEND = ["orca", "terminal", "send"];
const arg = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

const show = (terminal: Record<string, unknown>): Route => [
  SHOW,
  raw(JSON.stringify({ ok: true, result: { terminal: { handle: HANDLE, connected: true, writable: true, ...terminal } } })),
];

/** Scrubbed from a real `orca terminal show` of a Claude Code pane: status block, no personal data. */
const statusPreview = (...top: string[]) => [
  ...top,
  "─────────",
  "👤 planner@example.invalid [Max] | 🧠 Opus 5.5 (1M context) | 📁 bichir",
  "▰▰▰▰▱▱▱▱▱▱ 49% (494.7k/1000.0k) | 💰 $79.35 | ⏱ 41h12m (api 2h10m) | +2300 -5",
  "📊 📅 week 44% ↻2d20h",
  "▬┃ Claude Code 44%·52  policy: open",
  "-- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
].join("\n");

const IDLE: Record<string, unknown> = {
  // The real pane keeps its title glyph; Orca evaluated agentWait and found no wait.
  title: "◐ Pacer task dispatch stuck forever",
  agentWait: null,
  lastOutputAt: Date.now() - 60_000,
  preview: statusPreview("❯"),
};

function setup(...routes: Route[]) {
  const f = fakeRun(routes);
  return { f, ctx: fakeCtx({ run: f.run }) };
}

test("sends when the caller is idle at an empty prompt", async () => {
  const { f, ctx } = setup(show(IDLE), [SEND, ok("terminal-send.json")]);
  expect(await pingOrcaCaller(ctx, HANDLE, PING)).toBe("sent");
  expect(f.count(SEND)).toBe(1);
  const send = f.calls.find((a) => a[1] === "terminal" && a[2] === "send")!;
  expect(arg(send, "--terminal")).toBe(HANDLE);
  expect(arg(send, "--text")).toBe(PING);
  expect(send).toContain("--enter");
});

test("never types over a draft", async () => {
  const { f, ctx } = setup(show({ ...IDLE, preview: statusPreview("❯ fix the thing") }));
  expect(await pingOrcaCaller(ctx, HANDLE, PING)).toBe("busy");
  expect(f.count(SEND)).toBe(0);
});

test("waits while the agent is working", async () => {
  const { f, ctx } = setup(show({ ...IDLE, agentWait: undefined, lastOutputAt: Date.now() - 60_000 }));
  expect(await pingOrcaCaller(ctx, HANDLE, PING)).toBe("busy");
  expect(f.count(SEND)).toBe(0);
});

test("an agent parked on an interactive prompt is busy", async () => {
  const { f, ctx } = setup(show({ ...IDLE, agentWait: { source: "prompt-text", reason: "agent-approval-prompt" } }));
  expect(await pingOrcaCaller(ctx, HANDLE, PING)).toBe("busy");
  expect(f.count(SEND)).toBe(0);
});

test("terminal output in the last 30 s is busy", async () => {
  const { f, ctx } = setup(show({ ...IDLE, lastOutputAt: Date.now() - 1_000 }));
  expect(await pingOrcaCaller(ctx, HANDLE, PING)).toBe("busy");
  expect(f.count(SEND)).toBe(0);
});

test("a closed terminal is gone", async () => {
  const { f, ctx } = setup([SHOW, ok("terminal-show-closed.json")]);
  expect(await pingOrcaCaller(ctx, HANDLE, PING)).toBe("gone");
  expect(f.count(SEND)).toBe(0);
});

test("a stale handle is gone", async () => {
  const { f, ctx } = setup([SHOW, ok("terminal-show-stale.json")]);
  expect(await pingOrcaCaller(ctx, HANDLE, PING)).toBe("gone");
  expect(f.count(SEND)).toBe(0);
});

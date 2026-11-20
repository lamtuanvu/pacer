import { expect, test } from "bun:test";
import { pingOrcaCaller } from "../src/exec/orca/caller-ping";
import { type Route, fakeRun, ok, raw } from "./fixtures/orca/fake";
import { fakeCtx } from "./helpers";

const HANDLE = "term_00000000-0000-0000-0000-000000000001";
const PING = "pacer: task t-1 is done. Review and decide: `pacer review t-1 --accept|--reject`, or `pacer msg inbox`.";
const SHOW = ["orca", "terminal", "show"];
const READ = ["orca", "terminal", "read"];
const SEND = ["orca", "terminal", "send"];
const arg = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

const show = (terminal: Record<string, unknown>): Route => [
  SHOW,
  raw(JSON.stringify({ ok: true, result: { terminal: { handle: HANDLE, connected: true, writable: true, ...terminal } } })),
];

const screen = (tail: string[]): Route => [
  READ,
  raw(JSON.stringify({ ok: true, result: { terminal: { source: "screen", tail } } })),
];

/** Scrubbed from a real `orca terminal show` of a Claude Code pane: status block only, no prompt box, no personal data. */
const statusBlock = [
  "─────────",
  "👤 planner@example.invalid [Pro] | 🧠 Sonnet 5 (1M context) | 📁 sample-repo",
  "▰▰▰▰▰▱▱▱▱▱ 50% (100.0k/200.0k) | 💰 $1.23 | ⏱ 1h00m (api 0h10m) | +12 -3",
  "📊 📅 week 30% ↻1d0h",
  "▬┃ Sample Agent 60%·40  policy: review",
  "-- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
];

/** The prompt box as `orca terminal read --screen` returns it: the prompt row boxed by `─` rules, above the status block. */
const screenBox = (promptRow: string) => screen(["scrollback line", "…", "─────────", promptRow, "─────────", ...statusBlock]);

const IDLE: Record<string, unknown> = {
  // Claude Code marks an idle-at-prompt pane with the ✳ title prefix; Orca evaluated agentWait and found no wait.
  title: "✳ Example session",
  agentWait: null,
  lastOutputAt: Date.now() - 60_000,
  preview: statusBlock.join("\n"),
};

const emptyBox = screenBox("❯");

function setup(...routes: Route[]) {
  const f = fakeRun(routes);
  return { f, ctx: fakeCtx({ run: f.run }) };
}

test("sends when the caller is idle at an empty prompt", async () => {
  const { f, ctx } = setup(show(IDLE), emptyBox, [SEND, ok("terminal-send.json")]);
  expect(await pingOrcaCaller(ctx, HANDLE, PING)).toBe("sent");
  expect(f.count(SEND)).toBe(1);
  const send = f.calls.find((a) => a[1] === "terminal" && a[2] === "send")!;
  expect(arg(send, "--terminal")).toBe(HANDLE);
  expect(arg(send, "--text")).toBe(PING);
  expect(send).toContain("--enter");
});

test("never types over a draft", async () => {
  const { f, ctx } = setup(show(IDLE), screenBox("❯ fix the thing"));
  expect(await pingOrcaCaller(ctx, HANDLE, PING)).toBe("busy");
  expect(f.count(SEND)).toBe(0);
});

test("never types over a multi-line draft", async () => {
  const { f, ctx } = setup(show(IDLE), screen(["─────────", "❯ first line", "second line", "third line", "─────────", ...statusBlock]));
  expect(await pingOrcaCaller(ctx, HANDLE, PING)).toBe("busy");
  expect(f.count(SEND)).toBe(0);
});

test("a screen without a prompt box is busy", async () => {
  const { f, ctx } = setup(show(IDLE), screen(statusBlock));
  expect(await pingOrcaCaller(ctx, HANDLE, PING)).toBe("busy");
  expect(f.count(SEND)).toBe(0);
});

test("waits while the agent is working", async () => {
  const { f, ctx } = setup(show({ ...IDLE, title: "◐ Example session", agentWait: undefined }), emptyBox);
  expect(await pingOrcaCaller(ctx, HANDLE, PING)).toBe("busy");
  expect(f.count(SEND)).toBe(0);
});

test("an agent parked on an interactive prompt is busy", async () => {
  const { f, ctx } = setup(show({ ...IDLE, agentWait: { source: "prompt-text", reason: "agent-approval-prompt" } }), emptyBox);
  expect(await pingOrcaCaller(ctx, HANDLE, PING)).toBe("busy");
  expect(f.count(SEND)).toBe(0);
});

test("terminal output in the last 30 s is busy", async () => {
  const { f, ctx } = setup(show({ ...IDLE, lastOutputAt: Date.now() - 1_000 }), emptyBox);
  expect(await pingOrcaCaller(ctx, HANDLE, PING)).toBe("busy");
  expect(f.count(SEND)).toBe(0);
});

test("text with a newline is never sent", async () => {
  const { f, ctx } = setup(show(IDLE), emptyBox, [SEND, ok("terminal-send.json")]);
  expect(await pingOrcaCaller(ctx, HANDLE, "pacer: one\npacer: two")).toBe("busy");
  expect(f.count(SHOW)).toBe(0);
  expect(f.count(SEND)).toBe(0);
});

test("text with a control character is never sent", async () => {
  const { f, ctx } = setup(show(IDLE), emptyBox, [SEND, ok("terminal-send.json")]);
  expect(await pingOrcaCaller(ctx, HANDLE, "pacer: \x1b[2J ping")).toBe("busy");
  expect(f.count(SHOW)).toBe(0);
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

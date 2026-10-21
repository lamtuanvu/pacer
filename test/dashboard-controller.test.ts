import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fixture from "./fixtures/ui/snapshot.json";
import taskGet from "./fixtures/ui/task-get.json";
import settingsFixture from "./fixtures/ui/tui-settings.json";
import { setupChecklist } from "../src/setup/checklist";
import { ApiError, type ApiClient } from "../src/api/client";
import { callOp } from "../src/api/ops";
import { Dashboard } from "../src/dashboard/controller";
import { initialState, trigger } from "../src/dashboard/state";
import { withFallback } from "../src/dashboard/data";
import { PLAIN_THEME } from "../src/dashboard/theme";
import type { ClientSnapshot } from "../src/view-model/snapshot";
import { fakeCtx } from "./helpers";

const ALL_OPS = ["host.check", "host.set", "task.retry", "task.review", "task.get", "task.stop", "task.attach", "task.session", "task.delegate", "attention.dismiss", "task.dismiss",
  "config.get", "config.set", "agent.preview", "account.list", "account.signin", "notifications.get", "notifications.set", "runner.check", "runner.set", "runner.block", "runner.unblock", "runner.reorder", "routing.get", "routing.set"];

interface Call { op: string; params: unknown }
function setup(options: { ops?: string[]; respond?: (op: string, params: Record<string, unknown>) => unknown; client?: Partial<ApiClient>; snapshot?: ClientSnapshot; now?: () => number } = {}) {
  const calls: Call[] = [], frames: string[] = [], attached: string[] = [], handoffs: string[][] = [];
  const s = options.snapshot ?? structuredClone(fixture) as unknown as ClientSnapshot;
  const client: ApiClient = {
    kind: "http",
    hello: async () => ({ protocol: "3.0.0", pacer: "0", ops: options.ops ?? ALL_OPS, events: [] }),
    snapshot: async () => ({ protocol: "3.0.0", seq: 1, snapshot: s }),
    call: async <T,>(op: string, params?: unknown) => {
      calls.push({ op, params });
      const answer = options.respond?.(op, (params ?? {}) as Record<string, unknown>);
      if (answer instanceof Error) throw answer;
      if (answer !== undefined) return answer as T;
      if (op === "task.get") return { ...taskGet, id: (params as { id: string }).id } as T;
      return {} as T;
    },
    subscribe: () => () => {},
    close: () => {},
    ...options.client,
  };
  const dash = new Dashboard({
    client, theme: PLAIN_THEME, version: "0.0.0-test", cwd: "/tmp/repo", timeZone: "UTC",
    now: options.now ?? (() => s.at), size: () => ({ width: 120, height: 40 }), write: frame => frames.push(frame),
    attachHere: async id => { attached.push(id); }, handoff: async argv => { handoffs.push(argv); return 0; },
  });
  const keys = async (...list: string[]) => { for (const key of list) { await dash.key(key); await dash.settle(); } };
  const ops = () => calls.filter(c => !["task.get"].includes(c.op));
  return { dash, calls, ops, frames, attached, handoffs, keys, last: () => frames.at(-1)!, s };
}

test("new interactive session prompts for a request and repository", async () => {
  const t = setup({ops:[...ALL_OPS,"session.create","session.prepare","session.draft.create"]});
  await t.dash.refresh();await t.keys("n");
  expect(t.last()).toContain("Start an interactive session");
  await t.keys(..."Talk", "enter");
  expect(t.last()).toContain("Repository path");
});

test("Enter runs the selected row's primary service action with its exact params", async () => {
  const t = setup();
  await t.dash.refresh();
  await t.keys("enter");
  expect(t.ops()).toEqual([{ op: "host.check", params: { alias: "buildbox" } }]);
  expect(t.last()).toContain("✓ Run checks: done");
});

test("ui.open actions navigate inside the TUI instead of calling the service", async () => {
  const t = setup();
  await t.dash.refresh();
  await t.keys("j", "j", "enter");
  expect(t.dash.state.screen).toBe("review");
  expect(t.dash.state.selected.review).toBe("review:t-0412");
  expect(t.ops()).toEqual([]);
  expect(t.last().split("\n")[0]).toContain("[ Needs you ]");
});

test("accepting a review confirms, sends the revision guard and moves to the next item", async () => {
  const t = setup();
  await t.dash.refresh();
  await t.keys("2", "j", "j", "a");
  expect(t.last()).toContain('Accept "Fix flaky retry test in the payments client"?');
  expect(t.ops()).toEqual([]);
  await t.keys("y");
  expect(t.ops()).toEqual([{ op: "task.review", params: { id: "t-0412", expect_rev: 3, verdict: "accept" } }]);
  expect(t.last()).toContain("Accepted · next: Add dark mode to the web header");
  expect(t.dash.state.selected.review).toBe("review:t-0415");
});

test("reject and send back require a note; conflicts explain another client won", async () => {
  const t = setup({ respond: op => op === "task.review" ? new ApiError("conflict", "revision changed") : undefined });
  await t.dash.refresh();
  await t.keys("2", "j", "j", "r", "enter");
  expect(t.last()).toContain("Add a note first.");
  await t.keys(..."flaky", "enter");
  expect(t.ops()).toEqual([{ op: "task.review", params: { id: "t-0412", expect_rev: 3, verdict: "reject", note: "flaky" } }]);
  expect(t.last()).toContain("Another client already reviewed this task.");
});

test("retry offers only ready executors from the task detail", async () => {
  const t = setup();
  await t.dash.refresh();
  await t.keys("2", "j", "j");
  await t.keys("t");
  const menu = t.dash.state.overlay;
  expect(menu).toMatchObject({ kind: "menu", title: "Retry on" });
  expect(menu?.kind === "menu" && menu.actions.map(a => a.label)).toEqual(["Codex · Available"]);
  await t.keys("1");
  expect(t.ops().at(-1)).toEqual({ op: "task.review", params: { id: "t-0412", expect_rev: 3, verdict: "retry", executor: "codex" } });
});

test("review keys are absent when the service does not offer task.review", async () => {
  const t = setup({ ops: ALL_OPS.filter(op => op !== "task.review") });
  await t.dash.refresh();
  await t.keys("2", "j", "j", "a", "r", "s");
  expect(t.dash.state.overlay).toBeNull();
  expect(t.ops()).toEqual([]);
  expect(t.last()).toContain("does not offer reviews here");
});

test("stopping a running task always confirms and sends its revision", async () => {
  const t = setup();
  await t.dash.refresh();
  await t.keys("3", "s");
  expect(t.dash.state.overlay).toMatchObject({ kind: "confirm", title: "Stop this session and its executor?" });
  await t.keys("n");
  expect(t.ops()).toEqual([]);
  await t.keys("s", "y");
  expect(t.ops()).toEqual([{ op: "task.stop", params: { id: "t-0420", expect_rev: 3 } }]);
});

test("watching attaches builtin sessions here and other viewers through task.attach", async () => {
  const s = structuredClone(fixture) as unknown as ClientSnapshot;
  s.tasks[0]!.session = { host: "builtin", live: true, controller: null, viewers: 0 };
  const t = setup({ snapshot: s, respond: (op, p) => op === "task.session" ? { host: "builtin" } : op === "task.attach" ? { opened: false, command: `tmux attach ${p.id}` } : undefined });
  await t.dash.refresh();
  await t.keys("3", "enter");
  expect(t.attached).toEqual(["t-0420"]);
  await t.keys("m");
  expect(t.ops().at(-1)).toEqual({ op: "task.attach", params: { id: "t-0420", target: "tmux" } });
  expect(t.last()).toContain("Run: tmux attach t-0420");
});

test("delegate asks for goal, repository and work type, then calls task.delegate", async () => {
  const t = setup({ respond: op => op === "task.delegate" ? { task_id: "t-9000" } : undefined });
  await t.dash.refresh();
  await t.keys("d", "enter");
  expect(t.last()).toContain("Describe the goal first.");
  await t.keys(..."Fix it", "enter", "enter", ..."tests", "enter");
  expect(t.ops()).toEqual([{ op: "task.delegate", params: { goal: "Fix it", repo: "/tmp/repo", source: "ui", kind: "tests" } }]);
  expect(t.last()).toContain("Delegated · t-9000 queued");
});

test("service errors are shown with their hint", async () => {
  const t = setup({ respond: op => op === "host.check" ? new ApiError("not_allowed", "Live validation D8: host.check changes the real user environment", "Use the sandbox") : undefined });
  await t.dash.refresh();
  await t.keys("enter");
  expect(t.last()).toContain("✕ Live validation D8: host.check changes the real user environment (Use the sandbox)");
});

test("settings load their section through ops and adjust values with config.set", async () => {
  const t = setup({ respond: op => op === "config.get" ? { keys: { "pacing.planner_reserve": { value: 10, source: "default" }, "pacing.policy": { value: "even", source: "default" }, planner: { value: "claude-code", source: "default" } }, planners: ["claude-code", "codex#team"] } : op === "config.set" ? { key: "pacing.planner_reserve", value: 15, undo: "pacer config set pacing.planner_reserve 10" } : undefined });
  await t.dash.refresh();
  await t.keys("4");
  expect(t.calls.map(c => c.op)).toContain("config.get");
  await t.keys("enter", "j", "j", "right");
  expect(t.calls.find(c => c.op === "config.set")).toEqual({ op: "config.set", params: { key: "pacing.planner_reserve", value: 15 } });
  expect(t.last()).toContain("Saved. Undo: pacer config set pacing.planner_reserve 10");
  expect(t.calls.filter(c => c.op === "config.get")).toHaveLength(2);
});

test("changing the planner previews integration files and offers change only", async () => {
  const t = setup({ respond: op => op === "config.get" ? { keys: { planner: { value: "claude-code", source: "default" } }, planners: ["claude-code", "codex#team"] } : op === "agent.preview" ? { files: ["~/.codex/skills/pacer/SKILL.md"], undo: "pacer uninstall codex" } : undefined });
  await t.dash.refresh();
  await t.keys("4", "enter", "enter", "2");
  expect(t.calls.find(c => c.op === "agent.preview")?.params).toEqual({ agent: "codex" });
  expect(t.last()).toContain("~/.codex/skills/pacer/SKILL.md");
  expect(t.last()).toContain("o Change only");
  await t.keys("o");
  expect(t.calls.find(c => c.op === "config.set")).toEqual({ op: "config.set", params: { key: "planner", value: "codex#team", integrations: "skip" } });
});

test("account wizards hand the terminal to the pacer CLI and resume", async () => {
  const t = setup({ respond: op => op === "account.list" ? [{ name: "team", kind: "codex", source: "folder", executors: ["codex#team@devbox"], signedIn: true, locked: "In use by 1 executor(s)" }] : undefined });
  await t.dash.refresh();
  await t.keys("4", "j", "enter", "a");
  expect(t.handoffs).toEqual([["account", "add"]]);
  expect(t.last()).toContain("Add account: finished");
  await t.keys("x");
  expect(t.dash.state.overlay).toBeNull();
});

test("settings writes reach the real config through the in-process API", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "# preserved\naccounts:\n  personal: {kind: claude}\n  spare: {kind: codex}\nplanner: claude-code\nrouting:\n  - default: [codex#spare]\n");
  const t = setup({ client: { kind: "inprocess", call: async <T,>(op: string, params?: unknown) => await callOp(ctx, op, params ?? {}) as T } });
  await t.dash.refresh();
  await t.keys("4", "enter", "j", "right");
  expect(readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8")).toContain("policy: even");
  expect(readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8")).toContain("# preserved");
  await t.keys("escape", "j", "j", "j", "j", "j", "j", "j", "j", "j", "enter", "right");
  expect((await callOp(ctx, "notifications.get", {}) as { level: string }).level).toBe("all");
});

test("service action params pass through unchanged, including revision guards", async () => {
  const s = structuredClone(fixture) as unknown as ClientSnapshot;
  s.attention![1]!.actions[0]!.params.expect_rev = 3;
  const t = setup({ snapshot: s, respond: op => op === "task.retry" ? new ApiError("conflict", "revision changed", "refresh") : undefined });
  await t.dash.refresh();
  await t.keys("j", "enter");
  expect(t.ops()).toEqual([{ op: "task.retry", params: { id: "t-0409", executor: "codex#team@devbox", expect_rev: 3 } }]);
  expect(t.last()).toContain("✕ revision changed (refresh)");
});

test("watching a session hosted elsewhere goes through task.attach", async () => {
  const s = structuredClone(fixture) as unknown as ClientSnapshot;
  s.tasks[0]!.session = { host: "orca", live: true, controller: null, viewers: 0 };
  const t = setup({ snapshot: s, respond: op => op === "task.session" ? { host: "orca" } : op === "task.attach" ? { opened: true } : undefined });
  await t.dash.refresh();
  await t.keys("3", "enter");
  expect(t.attached).toEqual([]);
  expect(t.ops()).toEqual([{ op: "task.session", params: { id: "t-0420" } }, { op: "task.attach", params: { id: "t-0420", target: "orca" } }]);
  expect(t.last()).toContain("Opened task session.");
});

test("help lists only shortcuts whose operations are offered", async () => {
  const t = setup({ ops: [] });
  await t.dash.refresh();
  await t.keys("?");
  expect(t.last()).toContain("Keyboard shortcuts");
  for (const label of ["Delegate a task", "Dismiss", "Block or unblock", "Stop"]) expect(t.last()).not.toContain(label);
  await t.keys("d", "2", "a");
  expect(t.dash.state.overlay).toEqual({ kind: "help" });
});

test("legacy task states alone never raise Needs you", async () => {
  const s = structuredClone(fixture) as unknown as ClientSnapshot;
  s.attention = undefined;
  s.tasks = [{ ...s.tasks[5]!, state: "failed" }];
  const t = setup({ snapshot: s });
  await t.dash.refresh();
  expect(t.last()).toContain("Nothing needs you.");
});

test("a quiet service stays live: liveness follows successful reads, not the snapshot's own time", async () => {
  let clock = 0, failing = false;
  const s = structuredClone(fixture) as unknown as ClientSnapshot;
  clock = s.at + 300;
  const t = setup({ snapshot: s, now: () => clock, client: { snapshot: async () => { if (failing) throw new Error("connect ECONNREFUSED"); return { protocol: "3.0.0", seq: 1, snapshot: s }; } } });
  await t.dash.refresh();
  expect(t.last().split("\n")[0]).toContain("● live");
  failing = true; clock += 60;
  await t.dash.refresh();
  const top = t.last().split("\n")[0]!;
  expect(top).toContain("○ not responding");
  expect(top).not.toContain("● live");
  failing = false; clock += 2;
  await t.dash.refresh();
  expect(t.last().split("\n")[0]).toContain("● live");
});

// TD-6: Enter on a running row never stops the task, whatever kind of session it has.
for (const [label, session] of [
  ["no session", undefined],
  ["a headless session", { host: "none", live: false, controller: null, viewers: 0 }],
] as const) {
  test(`Enter on a running row with ${label} never sends task.stop (Home and Sessions)`, async () => {
    const s = structuredClone(fixture) as unknown as ClientSnapshot;
    const running = s.tasks.find(t => t.id === "t-0420")!;
    if (session) running.session = session as typeof running.session; else delete running.session;
    const t = setup({ snapshot: s });
    t.dash.state = { ...t.dash.state, selected: { home: "task:t-0420" } };
    await t.dash.refresh();
    await t.keys("enter");
    expect(t.ops().map(c => c.op)).not.toContain("task.stop");
    expect(t.dash.state.overlay).toBeNull();
    expect(t.dash.state.screen).toBe("sessions");
    expect(t.dash.state.selected.sessions).toBe("session:t-0420");
    await t.keys("enter", "enter");
    expect(t.ops().map(c => c.op)).not.toContain("task.stop");
    expect(t.dash.state.overlay).toBeNull();
    expect(t.attached).toEqual([]);
  });
}

test("Enter on an attachable running row watches instead of stopping", async () => {
  const s = structuredClone(fixture) as unknown as ClientSnapshot;
  s.tasks.find(t => t.id === "t-0420")!.session = { host: "builtin", live: true, controller: null, viewers: 0 };
  const t = setup({ snapshot: s, respond: op => op === "task.session" ? { host: "builtin" } : undefined });
  t.dash.state = { ...t.dash.state, selected: { home: "task:t-0420" } };
  await t.dash.refresh();
  await t.keys("enter");
  expect(t.ops().map(c => c.op)).not.toContain("task.stop");
  expect(t.attached).toEqual(["t-0420"]);
});

// TD-6: destructive and consequential settings and setup actions confirm before any op is sent.
const SETTINGS_OPS_ALL = [...ALL_OPS, "account.remove", "runner.remove", "project.strategy.list", "project.strategy.set", "project.strategy.remove", "strategy.list", "update.check", "update.apply", "service.install"];
const settingsResponse = (op: string) => {
  const key = ({ "config.get": "config", "account.list": "accounts", "routing.get": "routing", "project.strategy.list": "projects", "strategy.list": "strategies", "update.check": "update", "notifications.get": "notifications" } as Record<string, keyof typeof settingsFixture>)[op];
  return key ? structuredClone(settingsFixture[key].value) : undefined;
};
for (const c of [
  { name: "remove account", section: "accounts", item: "account:spare", key: "x", title: "Remove account spare?", op: "account.remove", params: { name: "spare" } },
  { name: "remove executor", section: "executors", item: "executor:cursor", key: "x", title: "Remove executor cursor?", op: "runner.remove", params: { id: "cursor" } },
  { name: "remove rule", section: "routing", item: "rule:0", key: "x", title: "Remove rule 1?", op: "routing.set" },
  { name: "use global strategy", section: "projects", item: "project:github.com/acme/api", key: "x", title: "Use the global strategy for acme/api?", op: "project.strategy.remove", params: { repo: "github.com/acme/api", expect_rev: 2 } },
  { name: "update and restart", section: "updates", item: "update:apply", key: "u", title: "Update pacer and restart the service?", op: "update.apply", params: {} },
]) {
  test(`${c.name} confirms before sending ${c.op}`, async () => {
    const t = setup({ ops: SETTINGS_OPS_ALL, respond: settingsResponse });
    t.dash.state = { ...t.dash.state, screen: "settings", section: c.section, focus: "detail", selected: { settings: c.item } };
    await t.dash.refresh();
    await t.dash.settle();
    t.dash.draw();
    const sent = () => t.ops().filter(x => x.op === c.op);
    await t.keys(c.key);
    expect(t.dash.state.overlay).toMatchObject({ kind: "confirm", title: c.title });
    expect(t.last()).toContain(c.title);
    expect(sent()).toEqual([]);
    await t.keys("n");
    expect(t.dash.state.overlay).toBeNull();
    expect(sent()).toEqual([]);
    await t.keys(c.key, "y");
    expect(sent()).toHaveLength(1);
    if (c.params) expect(sent()[0]!.params).toEqual(c.params);
  });
}

test("installing the service from Setup asks for consent first", async () => {
  const s = structuredClone(fixture) as unknown as ClientSnapshot;
  const checklist = setupChecklist({ version: "0.3.0", planner: "codex", service: { installed: false, running: false }, link: true, agents: [], executors: { ranked: [], excluded: [] } }, s.at);
  s.setup = { ...checklist, open: checklist.items.filter(i => i.status !== "done").length };
  const t = setup({ snapshot: s, ops: SETTINGS_OPS_ALL });
  t.dash.state = { ...t.dash.state, screen: "setup", selected: { setup: "setup:service" } };
  await t.dash.refresh();
  await t.keys("enter");
  expect(t.dash.state.overlay).toMatchObject({ kind: "confirm", title: "Run pacer in the background at login?" });
  expect(t.ops().map(x => x.op)).not.toContain("service.install");
  await t.keys("y");
  expect(t.ops().filter(x => x.op === "service.install")).toEqual([{ op: "service.install", params: { consent: true } }]);
});

test("the fallback warning is still shown on the first local frame after a slow local read", async () => {
  const s = structuredClone(fixture) as unknown as ClientSnapshot;
  let clock = s.at;
  const base = setup({ snapshot: s, now: () => clock }).dash.deps.client;
  const primary: ApiClient = { ...base, kind: "http", snapshot: async () => { throw new Error("connect ECONNREFUSED"); }, hello: async () => { throw new Error("connect ECONNREFUSED"); } };
  const local: ApiClient = { ...base, kind: "inprocess", snapshot: async () => { clock += 8; return { protocol: "3.0.0", seq: 1, snapshot: s }; } };
  const frames: string[] = [];
  let dash!: Dashboard;
  const client = withFallback(primary, () => local, () => dash.fallback());
  dash = new Dashboard({ client, theme: PLAIN_THEME, version: "0.0.0-test", cwd: "/tmp/repo", timeZone: "UTC", now: () => clock, size: () => ({ width: 120, height: 40 }), write: f => frames.push(f) });
  await dash.refresh();
  const first = frames.at(-1)!;
  expect(first.split("\n")[0]).toContain("○ local");
  expect(first).toContain("pacer serve unavailable; working locally");
  clock += 6;
  dash.draw();
  expect(frames.at(-1)!).not.toContain("pacer serve unavailable");
});

test("on the Setup screen shown in place of Home, j moves the visible selection and Enter acts on that row", async () => {
  const s = structuredClone(fixture) as unknown as ClientSnapshot;
  const checklist = setupChecklist({ version: "0.3.0", planner: "codex", service: { installed: false, running: false }, link: true, agents: [{ id: "codex", name: "Codex", installed: true, cliInstalled: true }], executors: { ranked: [], excluded: [] } }, s.at);
  s.setup = { ...checklist, open: checklist.items.filter(i => i.status !== "done").length };
  const t = setup({ snapshot: s, ops: SETTINGS_OPS_ALL });
  await t.dash.refresh();
  expect(t.dash.state.screen).toBe("home");
  const selectedRow = () => t.last().split("\n").find(line => line.startsWith(" ›")) ?? "";
  expect(selectedRow()).toContain("Background service");
  await t.keys("j");
  expect(selectedRow()).toContain("Connect planner");
  await t.keys("k", "enter");
  expect(t.dash.state.overlay).toMatchObject({ kind: "confirm", title: "Run pacer in the background at login?" });
  await t.keys("n");
  expect(t.dash.state.screen).toBe("home");
});

test("x skips the first delegation from Setup", async () => {
  const s = structuredClone(fixture) as unknown as ClientSnapshot;
  const checklist = setupChecklist({ version: "0.3.0", planner: "codex", service: { installed: true, running: true }, link: true, connected: true, agents: [{ id: "codex", name: "Codex", installed: true, cliInstalled: true }], executors: { ranked: [{ id: "codex" }], excluded: [] } }, s.at);
  s.setup = { ...checklist, open: checklist.items.filter(i => i.status !== "done").length };
  const t = setup({ snapshot: s, ops: [...SETTINGS_OPS_ALL, "onboarding.skip", "onboarding.try"] });
  t.dash.state = { ...t.dash.state, screen: "setup", selected: { setup: "setup:first" } };
  await t.dash.refresh();
  expect(t.last()).toContain("x skip first delegation");
  await t.keys("x");
  expect(t.ops()).toEqual([{ op: "onboarding.skip", params: {} }]);
});

test("Accept from Home's actions menu confirms before recording the verdict (TD-6)", async () => {
  const t = setup();
  t.dash.state = { ...t.dash.state, selected: { home: "attention:review:t-0412" } };
  await t.dash.refresh();
  await t.keys(".");
  expect(t.last()).toContain("2 Accept");
  await t.keys("2");
  expect(t.dash.state.overlay).toMatchObject({ kind: "confirm" });
  expect(t.last()).toContain("Fix flaky retry test in the payments client");
  expect(t.ops().filter(c => c.op === "task.review")).toEqual([]);
  await t.keys("y");
  expect(t.ops().filter(c => c.op === "task.review")).toEqual([{ op: "task.review", params: { id: "t-0412", verdict: "accept" } }]);
});

test("every consequential service action confirms, whatever screen offers it", () => {
  const act = (op: string, params: Record<string, unknown> = {}, style?: "danger") => ({ label: op, effect: { type: "action" as const, action: { label: op, op, params, ...(style ? { style } : {}) } } });
  for (const a of [act("task.review", { verdict: "accept" }), act("task.review", { verdict: "reject", note: "x" }), act("task.stop", { id: "t" }), act("account.remove"), act("runner.remove"), act("project.strategy.remove"), act("update.apply"), act("host.set", {}, "danger")]) {
    expect(trigger(initialState(), a).state.overlay).toMatchObject({ kind: "confirm" });
    expect(trigger(initialState(), a).effect).toBeUndefined();
  }
  expect(trigger(initialState(), act("host.check")).effect).toMatchObject({ type: "action" });
});

test("with update checks off, Settings › Updates offers no check and a check result says checks are off", async () => {
  const off = { current: "0.4.0", latest: null, available: false, disabled: true };
  const t = setup({ ops: SETTINGS_OPS_ALL, respond: op => op === "update.check" ? off : settingsResponse(op) });
  t.dash.state = { ...t.dash.state, screen: "settings", section: "updates", focus: "detail", selected: { settings: "update:check" } };
  await t.dash.refresh();
  await t.dash.settle();
  t.dash.draw();
  expect(t.last()).toContain("Update checking disabled");
  expect(t.last()).not.toContain("check now");
  expect(t.last().split("\n").at(-1)).not.toMatch(/⏎ Check now/i);
  const before = t.ops().filter(c => c.op === "update.check").length;
  await t.keys("enter");
  expect(t.ops().filter(c => c.op === "update.check").length).toBe(before);
  await t.dash.run({ type: "action", action: { label: "Check now", op: "update.check", params: { force: true } } });
  expect(t.last()).toContain("Update checks are off");
  expect(t.last()).not.toContain("Up to date");
});

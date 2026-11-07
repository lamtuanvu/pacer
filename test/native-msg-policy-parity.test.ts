import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { registerWork } from "../src/dispatch/work";
import { dispatchDatabase } from "../src/dispatch/store";
import { insertMessage } from "../src/messaging/store";
import type { TaskRecord } from "../src/tasks/types";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
const REPO = "github.com/acme/widgets";
const STRATEGY = "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n";
const MESSAGING = `messaging:
  tree: {max_turns: 12}
  liveness: {max_nudges: 5, interval_s: 30}
  rules:
    - {relation: [top_peer], kinds: [nudge], effect: deny}
    - {limits: {confirm: true, per_minute: 1}, from_kind: launched, to_kind: external, effect: allow}
    - {grant: not_required, relation: any, kinds: [report], effect: allow}
`;

function seed() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), STRATEGY + MESSAGING);
  writeFileSync(join(ctx.pacerHome, "project-messaging.json"), JSON.stringify({ version: 1, projects: {
    [REPO]: { liveness: { backoff_max_s: 120 }, max_turns: 8, rev: 3, rules: [
      { executor: "codex", effect: "deny", kinds: ["question"] },
      { effect: "allow", repo: "/srv/widgets", kinds: ["answer"], limits: { max_bytes: 10, per_minute: 2 } },
    ] },
    "github.com/acme/other": { rev: 1, rules: [{ effect: "deny" }] },
  } }, null, 2));
  const mk = (goal: string, n: number) => createTask({ ...ctx, now: ctx.now + n }, { brief: { goal, repo: "/srv/widgets" }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  const top = mk("top", 0), a = mk("a", 1), b = mk("b", 2), user = mk("user", 3), loose = mk("loose", 4);
  const repo = (t: TaskRecord) => { t.repo = { key: REPO } as TaskRecord["repo"]; };
  updateTask(ctx, top.id, t => { repo(t); t.origin = "external:claude-code"; t.state = "running";
    t.messaging = { max_turns: 4, rules: [{ relation: ["parent"], effect: "allow", from_position: "child", limits: { confirm: true } }] }; });
  registerWork(ctx, top.id, { allowDelegation: true });
  registerWork(ctx, a.id, {}, top.id);
  registerWork(ctx, b.id, {}, top.id);
  // A copied home re-imports the task JSON files, and queued managed tasks would reopen their
  // queue waits on every open; settled tasks keep the stores readable. Policy never reads waits.
  for (const id of [top.id, a.id, b.id]) updateTask(ctx, id, t => { t.state = "done"; });
  dispatchDatabase(ctx).run("DELETE FROM work_waits");
  updateTask(ctx, b.id, t => { t.run = { executor: "codex" } as TaskRecord["run"]; });
  updateTask(ctx, user.id, t => { repo(t); t.origin = "human"; });
  updateTask(ctx, loose.id, t => { t.origin = "external:local"; });
  // A send from `a` trips the per-minute cap of the global launched-to-external rule. It is dated
  // ahead so the cap still counts it however long the scenarios take.
  insertMessage({ ...ctx, now: Date.now() / 1000 + 3600 }, { taskId: a.id, rootId: `task:${top.id}`, from: `task:${a.id}`, to: "external:codex", kind: "message", body: "hi", replyTo: null, requestId: null });
  return { ctx, top: top.id, a: a.id, b: b.id, user: user.id, loose: loose.id };
}

function clone(home: string) {
  const copy = realpathSync(mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "mp-")));
  cpSync(home, copy, { recursive: true });
  return copy;
}

const env = (home: string, extra: Record<string, string>, forward: boolean) => ({
  HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin", PACER_CORE_ARGV: core,
  PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1",
  ...extra, ...(forward ? { PACER_FORWARD_OPS: "msg.policy" } : {}),
});

async function stdio(home: string, extra: Record<string, string>, requests: string[], forward: boolean) {
  const child = Bun.spawn([front!, "api", "--stdio"], { env: env(home, extra, forward), cwd: home, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    await child.stdin.write([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }), ...requests].join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(JSON.parse(lines[0]!).result.protocol).toBe("3.0.0");
    // Forwarded requests may answer out of order; each response carries its id.
    const ordered = lines.slice(1).sort((x, y) => JSON.parse(x).id - JSON.parse(y).id);
    return { lines: ordered, markers: stderr.split("\n").filter(line => /^native msg\.policy \d+$/.test(line)) };
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}

const rpc = (id: number, params: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method: "msg.policy", params });
const raw = (id: number, params: string) => `{"jsonrpc":"2.0","id":${id},"method":"msg.policy","params":${params}}`;

test.skipIf(!front)("stdio msg.policy matches the TypeScript core byte for byte", async () => {
  const s = seed();
  const t = (id: string) => `task:${id}`;
  const check = (from: string, to: string, kind = "message", grant?: boolean) => ({ check: { from, to, kind, ...(grant === undefined ? {} : { grant }) } });
  const params: unknown[] = [
    {}, { task: s.top }, { task: s.a }, { task: s.user }, { task: s.loose }, { task: "t-20990101-000000-ffff" },
    check("external:claude-code", t(s.top)), check(t(s.a), t(s.top)), check(t(s.a), t(s.b)), check(t(s.a), t(s.b), "message", true),
    check(t(s.a), t(s.b), "message", false), check("external:claude-code", t(s.user)), check("external:claude-code", t(s.user), "nudge"),
    check(t(s.a), t(s.user)), check("human", t(s.a)), check(t(s.a), "human"), check("human", "task:t-20990101-000000-ffff"),
    check("external:local", t(s.user)), check("external:local", t(s.loose)), check(t(s.loose), t(s.user)), check("broker", "human", "close"),
    check(t(s.a), "external:codex"), check(t(s.b), "external:codex"), check(t(s.b), t(s.top), "question"), check(t(s.a), t(s.top), "answer"),
    check(t(s.a), t(s.b), "report"), check("external:a", "external:b", "nudge"), check(t(s.a), t(s.a)), check("external:local", "external:local"),
    { task: s.user, ...check(t(s.a), t(s.top)) }, { task: s.top, ...check("external:x", t(s.user), "answer") },
    [], { task: 1 }, { task: "x", zz: 1 }, { check: "x" }, { check: null }, { check: {} },
    { check: { from: "nope", to: 3, kind: "x", grant: "y", extra: 1, more: 2 }, task: "bad", zz: 1 },
    { check: { from: `external:${"a".repeat(129)}`, to: "task:t-1", kind: "message" } }, { check: { from: "human", to: "human", kind: "close", grant: null } },
  ];
  const requests = [...params.map((p, n) => rpc(n + 2, p)), raw(200, "null"), raw(201, '{"check":{"from":"human","to":"human","kind":"close","grant":true}}')];
  const scenarios: { name: string; prepare?: (pacerHome: string) => void; env?: Record<string, string>; native: boolean }[] = [
    { name: "layered", native: true },
    { name: "no strategy", prepare: home => rmSync(join(home, "strategy.yaml")), native: true },
    { name: "invalid strategy", prepare: home => writeFileSync(join(home, "strategy.yaml"), STRATEGY + MESSAGING + "bogus_section: [\n"), native: true },
    { name: "invalid strategy section", prepare: home => writeFileSync(join(home, "strategy.yaml"), STRATEGY + "messaging: {tree: {max_turns: 0}}\n"), native: true },
    { name: "defaults off", prepare: home => writeFileSync(join(home, "strategy.yaml"), STRATEGY + "messaging: {defaults: false}\n"), native: true },
    { name: "no project file", prepare: home => rmSync(join(home, "project-messaging.json")), native: true },
    { name: "invalid project file", prepare: home => writeFileSync(join(home, "project-messaging.json"), '{"version":2}'), native: false },
    { name: "work grant", env: { PACER_WORK_GRANT: "pwg_bogus" }, native: false },
  ];
  for (const scenario of scenarios) {
    const nativeHome = clone(s.ctx.home), forwardHome = clone(s.ctx.home);
    try {
      for (const home of [nativeHome, forwardHome]) scenario.prepare?.(join(home, ".pacer"));
      const native = await stdio(nativeHome, scenario.env ?? {}, requests, false);
      const forwarded = await stdio(forwardHome, scenario.env ?? {}, requests, true);
      expect(native.lines, scenario.name).toEqual(forwarded.lines);
      expect(forwarded.markers, scenario.name).toEqual([]);
      const expected = scenario.native ? requests.map(r => `native msg.policy ${JSON.parse(r).id}`) : [];
      expect(native.markers, scenario.name).toEqual(expected);
      if (scenario.name === "layered") {
        const results = native.lines.map(line => JSON.parse(line));
        // The fixture exercises every layer, holds, grants, rate caps and denials rather than defaults alone.
        expect(results[1].result.rules.map((r: { layer: string }) => r.layer)).toEqual(["tree", "project", "project", "global", "global", "global", ...Array(6).fill("default")]);
        expect(results[1].result.config.tree.max_turns).toBe(4);
        const decisions = results.slice(6, 31).map(r => r.result.check.decision === "allow" ? `allow:${r.result.check.layer}:${r.result.check.hold}` : r.result.check.error.data?.reason ?? r.result.check.error.code);
        for (const d of ["allow:tree:true", "allow:default:false", "msg_forbidden", "msg_cap_reached", "not_found", "allow:project:false"]) expect(decisions).toContain(d);
      }
    } finally {
      rmSync(nativeHome, { recursive: true, force: true });
      rmSync(forwardHome, { recursive: true, force: true });
    }
  }
}, 180000);

test.skipIf(!front)("stdio msg.policy opens the task store only for task participants", async () => {
  const requests = [rpc(2, {}), rpc(3, { check: { from: "human", to: "external:codex", kind: "message" } }), rpc(4, { check: { from: "external:a", to: "external:b", kind: "nudge" } })];
  const homes = [false, true].map(() => realpathSync(mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "mp-"))));
  try {
    const [native, forwarded] = await Promise.all(homes.map(async (home, n) => {
      mkdirSync(join(home, ".pacer"), { recursive: true });
      writeFileSync(join(home, ".pacer/strategy.yaml"), STRATEGY);
      const out = await stdio(home, {}, requests, n === 1);
      return { ...out, db: existsSync(join(home, ".pacer/state/tasks.db")) };
    }));
    expect(native!.markers).toEqual(["native msg.policy 2", "native msg.policy 3", "native msg.policy 4"]);
    expect(native!.lines).toEqual(forwarded!.lines);
    expect(native!.db).toBe(forwarded!.db);
  } finally {
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
}, 60000);

import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Status } from "../src/engine/status";
import { runDoctor, renderDoctor, type Check } from "../src/install/doctor";
import { sha256 } from "../src/install/fsx";
import { writeManifest, type FileChange } from "../src/install/manifest";
import type { Ctx } from "../src/types";
import { fakeCtx } from "./helpers";

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function fixture() {
  const ctx = fakeCtx();
  put(join(ctx.pacerHome, "strategy.yaml"), `planner: claude-code
providers:
  claude-code: {usage: quota}
  codex: {usage: quota}
  cursor: {usage: reactive}
  agy: {usage: reactive}
  byteplus: {via: opencode, model: coding-plan/example, usage: quota, quota_source: arkcli}
routing:
  - default: [codex]
`);
  return ctx;
}
function status(): Status {
  return {
    generatedAt: 0, strategy: "default", planner: "claude-code", mode: "normal",
    disabled: false, calendarPace: true, executors: { ranked: [], excluded: [] },
    providers: ["claude-code", "codex", "cursor", "agy", "opencode#byteplus"].map(id => ({
      id, usage: "quota", windows: [], binding: null, verdict: "OK", installed: true, stale: false,
    })),
  };
}
function record(ctx: Ctx, planner: string, files: FileChange[]) {
  writeManifest(ctx, { version: 1, planners: { [planner]: {
    planner, installedAt: ctx.now, pacerArgv: ["pacer"], files, commands: [], notes: [],
  } } });
}
function find(checks: Check[], name: string): Check {
  const result = checks.find(c => c.name === name);
  expect(result).toBeDefined();
  return result!;
}

test("doctor fixture covers ok, warn, fail and info with usage and legacy fixes", async () => {
  const ctx = fixture();
  ctx.which = bin => bin === "codex" ? null : `/fake/${bin}`;
  ctx.run = async (argv, timeout) => {
    expect(argv).toEqual(["orca", "status", "--json"]);
    expect(timeout).toBe(5000);
    return { code: 0, stdout: '{"ok":true,"result":{"runtime":{"reachable":true}}}', stderr: "" };
  };
  put(join(ctx.home, ".claude.json"), '{"oauthAccount":{}}');
  put(join(ctx.home, ".cursor", "cli-config.json"), '{"authInfo":{}}');
  put(join(ctx.home, ".local/share/opencode/auth.json"), '{}');
  put(join(ctx.home, ".claude/scripts/budget/subagent_guard.py"), "legacy");
  const path = join(ctx.home, ".codex/AGENTS.md");
  put(path, "policy");
  record(ctx, "codex", [{ path, action: "created", afterHash: sha256("policy"), undo: [] }]);
  const s = status();
  s.providers[0].error = "no Claude rate-limit data yet (the Claude Code status line writes it)";
  s.providers[1].stale = true;
  s.providers[2].verdict = "UNKNOWN";
  s.providers[3].error = "usage unavailable";
  const checks = await runDoctor(ctx, { status: async () => s });
  expect(new Set(checks.map(c => c.level))).toEqual(new Set(["ok", "warn", "fail", "info"]));
  expect(find(checks, "Strategy").level).toBe("ok");
  expect(find(checks, "Binary codex")).toMatchObject({ level: "fail", fix: "install codex or remove providers.codex" });
  expect(find(checks, "Binary opencode#byteplus").detail).toContain("opencode");
  expect(find(checks, "Login claude-code").level).toBe("ok");
  expect(find(checks, "Login codex")).toMatchObject({ level: "warn", fix: "codex login" });
  expect(find(checks, "Login cursor").level).toBe("ok");
  expect(find(checks, "Login opencode").level).toBe("ok");
  expect(find(checks, "Login arkcli").level).toBe("info");
  expect(find(checks, "Login agy").level).toBe("info");
  expect(find(checks, "Usage claude-code")).toMatchObject({ level: "warn", fix: "pacer install claude-code, then use Claude Code once" });
  expect(find(checks, "Usage codex").level).toBe("warn");
  expect(find(checks, "Usage cursor").level).toBe("warn");
  expect(find(checks, "Usage agy")).toMatchObject({ level: "warn", detail: "usage unavailable" });
  expect(find(checks, "Usage opencode#byteplus").level).toBe("ok");
  expect(find(checks, "Orca").level).toBe("ok");
  expect(find(checks, "Activity")).toMatchObject({ level: "info", detail: "calendar pace" });
  expect(find(checks, "Install codex").level).toBe("ok");
  expect(find(checks, "Legacy guard")).toMatchObject({ level: "warn", fix: "pacer install claude-code migrates it" });
});

test("missing and invalid strategies fail without calling status", async () => {
  for (const text of [null, "planner: invalid\nproviders: {}\n", "providers: [\n"]) {
    const ctx = fakeCtx({ which: () => null });
    if (text !== null) put(join(ctx.pacerHome, "strategy.yaml"), text);
    const checks = await runDoctor(ctx, { status: async () => { throw new Error("must not call status"); } });
    expect(find(checks, "Strategy").level).toBe("fail");
    if (text === null) expect(find(checks, "Strategy").fix).toBe("pacer init");
    else expect(find(checks, "Strategy").detail).toContain(text.includes("invalid") ? "planner must be one of" : "YAML syntax error");
    expect(checks.some(c => c.name.startsWith("Usage"))).toBe(false);
    expect(find(checks, "Orca").level).toBe("info");
    expect(find(checks, "Installs").level).toBe("warn");
  }
});

test("cheap login indicators use fixture files and ctx env only", async () => {
  const ctx = fixture();
  put(join(ctx.home, ".claude.json"), "invalid JSON");
  put(join(ctx.home, ".cursor/cli-config.json"), '{"authInfo":"invalid"}');
  let checks = await runDoctor(ctx, { status: async () => status() });
  expect(find(checks, "Login claude-code").fix).toBe("run claude and log in");
  expect(find(checks, "Login cursor").fix).toBe("cursor-agent login");
  expect(find(checks, "Login opencode").fix).toBe("opencode auth login");
  ctx.env.ANTHROPIC_API_KEY = "test-key";
  put(join(ctx.home, ".codex/auth.json"), "{}");
  checks = await runDoctor(ctx, { status: async () => status() });
  expect(find(checks, "Login claude-code").level).toBe("ok");
  expect(find(checks, "Login codex").level).toBe("ok");
});

test("Orca failures warn about direct backend and missing binary is info", async () => {
  for (const stdout of ['{"result":{"runtime":{"reachable":false}}}', '{"runtime":{"reachable":true}}', "invalid"]) {
    const ctx = fixture();
    ctx.run = async () => ({ code: 0, stdout, stderr: "" });
    expect(find(await runDoctor(ctx, { status: async () => status() }), "Orca")).toMatchObject({ level: "warn", detail: "tasks use the direct backend" });
  }
  const ctx = fixture();
  ctx.run = async () => { throw new Error("timed out"); };
  expect(find(await runDoctor(ctx, { status: async () => status() }), "Orca").level).toBe("warn");
  ctx.which = bin => bin === "orca" ? null : "/fake/bin";
  expect(find(await runDoctor(ctx, { status: async () => status() }), "Orca").level).toBe("info");
});

test("activity reports learned days only for usable profile", async () => {
  const ctx = fixture();
  for (const days of [3, 12]) {
    put(join(ctx.pacerHome, "activity.json"), JSON.stringify({ builtAt: ctx.now, days, bins: Array(168).fill(1), active: Array(168).fill(true) }));
    expect(find(await runDoctor(ctx, { status: async () => status() }), "Activity").detail).toBe(days === 3 ? "calendar pace" : "learned from 12 days");
  }
});

test("install integrity uses hash or owned pieces and warns on missing pieces", async () => {
  const ctx = fixture();
  const path = join(ctx.home, ".codex/AGENTS.md");
  const marked = "<!-- >>> pacer >>> -->\npolicy\n<!-- <<< pacer <<< -->\n";
  record(ctx, "codex", [{ path, action: "created", afterHash: sha256(marked), undo: [{ kind: "block", style: "md" }] }]);
  for (const text of [marked, `user edits\n${marked}`, "user edits\n"]) {
    put(path, text);
    const check = find(await runDoctor(ctx, { status: async () => status() }), "Install codex");
    expect(check.level).toBe(text.includes("pacer") ? "ok" : "warn");
    if (check.level === "warn") expect(check.fix).toBe("pacer install codex");
  }
  record(ctx, "codex", [{ path: join(ctx.home, "missing"), action: "created", undo: [] }]);
  expect(find(await runDoctor(ctx, { status: async () => status() }), "Install codex").level).toBe("warn");
});

test("doctor default status diagnoses absent Claude data and handles status rejection", async () => {
  const ctx = fixture();
  const checks = await runDoctor(ctx);
  expect(find(checks, "Usage claude-code").fix).toBe("pacer install claude-code, then use Claude Code once");
  const failed = await runDoctor(ctx, { status: async () => { throw new Error("status failed"); } });
  expect(find(failed, "Usage claude-code")).toMatchObject({ level: "warn", detail: "status failed" });
});

test("renderDoctor prints exact labels and indented fixes", () => {
  expect(renderDoctor([
    { name: "Strategy", level: "ok", detail: "valid" },
    { name: "Usage", level: "warn", detail: "stale", fix: "refresh" },
    { name: "Binary", level: "fail", detail: "missing", fix: "install" },
    { name: "Activity", level: "info", detail: "calendar pace" },
  ])).toBe("[ok] Strategy: valid\n[warn] Usage: stale\n  fix: refresh\n[FAIL] Binary: missing\n  fix: install\n[info] Activity: calendar pace\n");
});

test("doctor checks executor launch flags from cached five-second CLI help",async()=>{
  const ctx=fixture();const calls:string[][]=[];ctx.run=async(argv,ms)=>{
    calls.push(argv);expect(ms).toBe(5000);
    if(argv[0]==="codex")return {code:0,stdout:"-C -s --skip-git-repo-check -o -m",stderr:""};
    if(argv[0]==="agy")return {code:0,stdout:"-p --sandbox --add-dir --model",stderr:""};
    return {code:0,stdout:"--agent -m --auto --title --workspace --force -p --output-format --model",stderr:""};
  };
  const checks=await runDoctor(ctx,{status:async()=>status(),service:async()=>({installed:false,running:false,healthy:false,binaryMatches:false}) as any});
  expect(checks.find(c=>c.name==="CLI codex")?.level).toBe("ok");
  expect(checks.find(c=>c.name==="CLI agy")?.detail).toContain("--dangerously-skip-permissions");await runDoctor(ctx,{status:async()=>status(),service:async()=>({installed:false,running:false,healthy:false,binaryMatches:false}) as any});
  expect(calls.filter(a=>a[0]==="codex")).toHaveLength(2);
});

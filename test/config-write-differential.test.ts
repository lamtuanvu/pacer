import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as routing from "../src/core/routing-config";
import * as runners from "../src/core/runners-config";
import * as notify from "../src/core/notify";
import * as strategy from "../src/strategy/service";
import { useStrategy } from "../src/config/strategy";
import { pluginDataDir } from "../src/link/paths";
import { fakeCtx } from "./helpers";
import golden from "./fixtures/config-writes-goldens.json";

const root = join(import.meta.dir, "..");
const yaml = golden.initial;

function home() {
  const dir = mkdtempSync(join(tmpdir(), "pacer-config-diff-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "strategy.yaml"), yaml, { mode: 0o600 });
  return dir;
}

function rust(binary: string, input: Record<string, unknown>) {
  return JSON.parse(execFileSync(binary, [], { input: JSON.stringify(input) + "\n" }).toString());
}

function configBinary() {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-config", "--example", "config_write_diff", "--locked"], { cwd: root });
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root }).toString());
  return join(metadata.target_directory, "debug/examples/config_write_diff");
}

function result(value: unknown, homePath: string) {
  return JSON.parse(JSON.stringify(value).replaceAll(homePath, "$HOME"));
}

test("seeded routing, runner order and notification writes match TS bytes and results", async () => {
  const binary = configBinary();
  let seed = 0x1a2b3c4d;
  const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let i = 0; i < 24; i++) {
    const tsHome = home(), rsHome = home();
    const ctx = fakeCtx({ pacerHome: tsHome });
    const order = rand() & 1 ? ["cursor", "codex"] : ["codex", "cursor"];
    const rules = rand() & 1
      ? [{ kinds: ["docs"], executors: order }, { executors: [...order].reverse() }]
      : [{ kinds: ["docs"], executors: [...order].reverse() }, { executors: order }];
    const options = { enabled: (rand() & 1) === 0, model: rand() & 1 ? null : "model-x", max_tasks: 2, rank: rand() % 2 };
    for (const input of [{ op: "routing.set", rules }, { op: "runner.reorder", ids: order }, { op: "runner.set", id: "codex", options }] as const) {
      let ts: unknown;
      try {
        ts = { ok: true, value: input.op === "routing.set" ? await routing.set(ctx, input.rules) : input.op === "runner.reorder" ? await runners.reorder(ctx, input.ids) : await runners.set(ctx, input.id, input.options) };
      } catch (error) { ts = { ok: false, error: (error as Error).message }; }
      const rs = rust(binary, { ...input, home: rsHome });
      expect(result(rs, rsHome)).toEqual(result(ts, tsHome));
      expect(readFileSync(join(rsHome, "strategy.yaml"), "utf8")).toBe(readFileSync(join(tsHome, "strategy.yaml"), "utf8"));
    }
    const tsRemoved = await runners.remove(ctx, "cursor");
    const rsRemoved = rust(binary, { op: "runner.remove", home: rsHome, id: "cursor" });
    expect(result(rsRemoved, rsHome)).toEqual(result({ ok: true, value: tsRemoved }, tsHome));
    expect(readFileSync(join(rsHome, "strategy.yaml"), "utf8")).toBe(readFileSync(join(tsHome, "strategy.yaml"), "utf8"));
    const level = ["off", "important", "all"][rand() % 3]!;
    const tsLevel = notify.setLevel(ctx, level as notify.NotificationLevel);
    const rsLevel = rust(binary, { op: "notifications.set", home: rsHome, level });
    expect(rsLevel).toEqual({ ok: true, value: tsLevel });
    expect(readFileSync(join(rsHome, "settings.json"), "utf8")).toBe(readFileSync(join(tsHome, "settings.json"), "utf8"));
    expect(statSync(join(rsHome, "settings.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(tsHome, "settings.json")).mode & 0o777).toBe(0o600);
  }
}, 30_000);

test("removing a runner drops its empty routing rule without changing surviving comments", async () => {
  const binary = configBinary();
  const tsHome = home(), rsHome = home();
  const changed = yaml.replace("executors: [codex, cursor] # keep list", "executors: [cursor] # keep list");
  writeFileSync(join(tsHome, "strategy.yaml"), changed);
  writeFileSync(join(rsHome, "strategy.yaml"), changed);
  const ctx = fakeCtx({ pacerHome: tsHome });
  const ts = await runners.remove(ctx, "cursor");
  const rs = rust(binary, { op: "runner.remove", home: rsHome, id: "cursor" });
  expect(result(rs, rsHome)).toEqual(result({ ok: true, value: ts }, tsHome));
  expect(readFileSync(join(rsHome, "strategy.yaml"), "utf8")).toBe(readFileSync(join(tsHome, "strategy.yaml"), "utf8"));
});

test("named strategy save matches TS result and generated YAML bytes", () => {
  const binary = configBinary();
  const drafts: strategy.Draft[] = [
    { from: "default", description: "Review routing", set: {} },
    { from: "default", description: "", set: {} },
    { from: "default", description: "Review routing", set: { "pacing.order": ["cursor", "codex"], "pacing.planner_reserve": 25 } },
    { from: "default", set: { "pacing.policy": "even", "pacing.planner_probe": "off" } },
    { from: "default", set: { routing: [{ kinds: ["docs"], executors: ["cursor"] }, { default: ["codex"] }] } },
  ];
  for (const draft of drafts) {
    const tsHome = home(), rsHome = home();
    const ctx = fakeCtx({ pacerHome: tsHome });
    const name = "review";
    const reason = "Approved by user";
    const who = "Codex";
    const ts = strategy.save(ctx, name, draft, reason, { who });
    const rs = rust(binary, { op: "strategy.save", home: rsHome, name, draft, reason, who, nowIso: new Date(ctx.now * 1000).toISOString() });
    expect(result(rs, rsHome)).toEqual(result({ ok: true, value: ts }, tsHome));
    expect(readFileSync(join(rsHome, "strategies", "review.yaml"), "utf8")).toBe(readFileSync(join(tsHome, "strategies", "review.yaml"), "utf8"));
    expect(statSync(join(rsHome, "strategies", "review.yaml")).mode & 0o777).toBe(0o600);
    expect(statSync(join(rsHome, "strategies")).mode & 0o777).toBe(0o700);
    expect(statSync(join(tsHome, "strategies", "review.yaml")).mode & 0o777).toBe(0o600);
    expect(statSync(join(tsHome, "strategies")).mode & 0o777).toBe(0o700);
    const tsUse = (strategy.show(ctx, name), { name, path: useStrategy(ctx, name) });
    const rsUse = rust(binary, { op: "strategy.use", home: rsHome, name });
    expect(result(rsUse, rsHome)).toEqual(result({ ok: true, value: tsUse }, tsHome));
    expect(readFileSync(join(rsHome, "active"), "utf8")).toBe(readFileSync(join(tsHome, "active"), "utf8"));
    const revised: strategy.Draft = { from: "default", set: { "pacing.planner_reserve": 30 } };
    let tsActiveError = "";
    try { strategy.save(ctx, name, revised, reason, { who, overwrite: true }); } catch (error) { tsActiveError = (error as Error).message; }
    expect(rust(binary, { op: "strategy.save", home: rsHome, name, draft: revised, reason, who, nowIso: new Date(ctx.now * 1000).toISOString(), overwrite: true })).toEqual({ ok: false, error: tsActiveError });
    const tsOverwrite = strategy.save(ctx, name, revised, reason, { who, overwrite: true, activeOk: true });
    const rsOverwrite = rust(binary, { op: "strategy.save", home: rsHome, name, draft: revised, reason, who, nowIso: new Date(ctx.now * 1000).toISOString(), overwrite: true, activeOk: true });
    expect(result(rsOverwrite, rsHome)).toEqual(result({ ok: true, value: tsOverwrite }, tsHome));
    expect(readFileSync(join(rsHome, "strategies", "review.yaml"), "utf8")).toBe(readFileSync(join(tsHome, "strategies", "review.yaml"), "utf8"));
    useStrategy(ctx, "default");
    rust(binary, { op: "strategy.use", home: rsHome, name: "default" });
    const tsRemove = strategy.remove(ctx, name);
    const rsRemove = rust(binary, { op: "strategy.remove", home: rsHome, name });
    expect(rsRemove).toEqual({ ok: true, value: tsRemove });
  }
});

test("runner.set accepts integral JSON decimal rank with byte parity", async () => {
  const binary = configBinary();
  const tsHome = home(), rsHome = home();
  const ts = await runners.set(fakeCtx({ pacerHome: tsHome }), "codex", { rank: 1.0 });
  const raw = `{"op":"runner.set","home":${JSON.stringify(rsHome)},"id":"codex","options":{"rank":1.0}}\n`;
  const rs = JSON.parse(execFileSync(binary, [], { input: raw }).toString());
  expect(result(rs, rsHome)).toEqual(result({ ok: true, value: ts }, tsHome));
  expect(readFileSync(join(rsHome, "strategy.yaml"), "utf8")).toBe(readFileSync(join(tsHome, "strategy.yaml"), "utf8"));
});

test("state writers tighten file and directory modes under both umasks", async () => {
  const binary = configBinary();
  for (const mask of [0o022, 0o077]) {
    const oldMask = process.umask(mask);
    try {
      const tsHome = home(), rsHome = home();
      const ctx = fakeCtx({ pacerHome: tsHome });
      for (const dir of [tsHome, rsHome]) chmodSync(join(dir, "strategy.yaml"), 0o644);
      const tsSet = notify.setLevel(ctx, "all");
      const rsSet = rust(binary, { op: "notifications.set", home: rsHome, level: "all" });
      expect(rsSet).toEqual({ ok: true, value: tsSet });
      for (const dir of [tsHome, rsHome]) expect(statSync(join(dir, "settings.json")).mode & 0o777).toBe(0o600);
      const tsSave = strategy.save(ctx, "review", { from: "default", description: "" }, "approved");
      const rsSave = rust(binary, { op: "strategy.save", home: rsHome, name: "review", draft: { from: "default", description: "" }, reason: "approved", nowIso: new Date(ctx.now * 1000).toISOString() });
      expect(result(rsSave, rsHome)).toEqual(result({ ok: true, value: tsSave }, tsHome));
      for (const dir of [tsHome, rsHome]) {
        expect(statSync(join(dir, "strategies")).mode & 0o777).toBe(0o700);
        expect(statSync(join(dir, "strategies", "review.yaml")).mode & 0o777).toBe(0o600);
      }
      for (const dir of [tsHome, rsHome]) {
        chmodSync(join(dir, "settings.json"), 0o644);
        chmodSync(join(dir, "strategies"), 0o755);
        chmodSync(join(dir, "strategies", "review.yaml"), 0o644);
      }
      notify.setLevel(ctx, "important");
      rust(binary, { op: "notifications.set", home: rsHome, level: "important" });
      const revised = { from: "default", description: "updated" };
      strategy.save(ctx, "review", revised, "approved", { overwrite: true });
      rust(binary, { op: "strategy.save", home: rsHome, name: "review", draft: revised, reason: "approved", nowIso: new Date(ctx.now * 1000).toISOString(), overwrite: true });
      for (const dir of [tsHome, rsHome]) {
        expect(statSync(join(dir, "settings.json")).mode & 0o777).toBe(0o600);
        expect(statSync(join(dir, "strategies")).mode & 0o777).toBe(0o700);
        expect(statSync(join(dir, "strategies", "review.yaml")).mode & 0o777).toBe(0o600);
      }
      const tsRunner = await runners.set(ctx, "codex", { rank: 1 });
      const rsRunner = rust(binary, { op: "runner.set", home: rsHome, id: "codex", options: { rank: 1 } });
      expect(rsRunner.ok).toBe(true);
      expect(statSync(join(tsHome, "strategy.yaml")).mode & 0o777).toBe(0o600);
      expect(statSync(join(rsHome, "strategy.yaml")).mode & 0o777).toBe(0o600);
      expect(result(rsRunner, rsHome)).toEqual(result({ ok: true, value: tsRunner }, tsHome));
    } finally { process.umask(oldMask); }
  }
});

test("save refusals and notification migration match TS errors and bytes", () => {
  const binary = configBinary();
  const tsHome = home(), rsHome = home();
  const ctx = fakeCtx({ pacerHome: tsHome });
  const nowIso = new Date(ctx.now * 1000).toISOString();
  const cases: {name: string; draft: strategy.Draft; reason: string}[] = [
    { name: "default", draft: { from: "default" }, reason: "approved" },
    { name: "draft", draft: { from: "default", set: { "pacing.planer_reserve": 20 } }, reason: "approved" },
    { name: "draft", draft: { from: "default", set: { "routing.0": 1 } }, reason: "approved" },
    { name: "draft", draft: { from: "default" }, reason: " " },
  ];
  for (const item of cases) {
    let tsError = "";
    try { strategy.save(ctx, item.name, item.draft, item.reason); } catch (error) { tsError = (error as Error).message; }
    const rs = rust(binary, { op: "strategy.save", home: rsHome, ...item, nowIso });
    expect(rs).toEqual({ ok: false, error: tsError });
  }
  const legacyTs = pluginDataDir(ctx);
  const legacyRs = join(rsHome, "legacy-plugin-data");
  mkdirSync(legacyTs, { recursive: true });
  mkdirSync(legacyRs, { recursive: true });
  writeFileSync(join(legacyTs, "settings.json"), '{"notifications":"all"}');
  writeFileSync(join(legacyRs, "settings.json"), '{"notifications":"all"}');
  expect(rust(binary, { op: "notifications.get", home: rsHome, legacyPluginData: legacyRs })).toEqual({ ok: true, value: notify.getLevel(ctx) });
  expect(readFileSync(join(rsHome, "settings.json"), "utf8")).toBe(readFileSync(join(tsHome, "settings.json"), "utf8"));
  let tsError = "";
  try { notify.setLevel(ctx, "bad" as notify.NotificationLevel); } catch (error) { tsError = (error as Error).message; }
  expect(rust(binary, { op: "notifications.set", home: rsHome, level: "bad" })).toEqual({ ok: false, error: tsError });
});

test("routing rule insertion keeps surviving YAML nodes", async () => {
  const binary = configBinary();
  const tsHome = home(), rsHome = home();
  const ctx = fakeCtx({ pacerHome: tsHome });
  const rules = [
    { kinds: ["docs"], executors: ["codex"] },
    { kinds: ["feature"], executors: ["cursor"] },
    { executors: ["codex", "cursor"] },
  ];
  const ts = await routing.set(ctx, rules);
  const rs = rust(binary, { op: "routing.set", home: rsHome, rules });
  expect(result(rs, rsHome)).toEqual(result({ ok: true, value: ts }, tsHome));
  expect(readFileSync(join(rsHome, "strategy.yaml"), "utf8")).toBe(readFileSync(join(tsHome, "strategy.yaml"), "utf8"));
});

test("runner reorder migrates a legacy strategy and keeps backup parity", async () => {
  const binary = configBinary();
  const tsHome = home(), rsHome = home();
  const legacy = "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n  cursor: {}\n";
  writeFileSync(join(tsHome, "strategy.yaml"), legacy);
  writeFileSync(join(rsHome, "strategy.yaml"), legacy);
  const ctx = fakeCtx({ pacerHome: tsHome });
  const ids = ["cursor", "codex"];
  const ts = await runners.reorder(ctx, ids);
  const rs = rust(binary, { op: "runner.reorder", home: rsHome, ids });
  expect(result(rs, rsHome)).toEqual(result({ ok: true, value: ts }, tsHome));
  for (const file of ["strategy.yaml", "strategy.yaml.pre-accounts.bak"]) {
    expect(readFileSync(join(rsHome, file), "utf8")).toBe(readFileSync(join(tsHome, file), "utf8"));
  }
});

test("routing and runner refusals leave both homes byte-identical", async () => {
  const binary = configBinary();
  const tsHome = home(), rsHome = home();
  const ctx = fakeCtx({ pacerHome: tsHome });
  const cases = [
    { op: "routing.set", rules: [{ kinds: ["docs"], executors: ["codex"] }] },
    { op: "routing.set", rules: [{ executors: ["missing"] }] },
    { op: "runner.reorder", ids: ["codex"] },
    { op: "runner.set", id: "claude-code", options: { enabled: false } },
    { op: "runner.remove", id: "claude-code" },
  ];
  for (const input of cases) {
    let tsError = "";
    try {
      if (input.op === "routing.set") await routing.set(ctx, input.rules!);
      if (input.op === "runner.reorder") await runners.reorder(ctx, input.ids!);
      if (input.op === "runner.set") await runners.set(ctx, input.id!, input.options!);
      if (input.op === "runner.remove") await runners.remove(ctx, input.id!);
    } catch (error) { tsError = (error as Error).message; }
    expect(rust(binary, { ...input, home: rsHome })).toEqual({ ok: false, error: tsError });
    expect(readFileSync(join(rsHome, "strategy.yaml"), "utf8")).toBe(readFileSync(join(tsHome, "strategy.yaml"), "utf8"));
  }
});

test("committed byte goldens cover each P2-C write family", () => {
  const binary = configBinary();
  const rsHome = home();
  const step = (input: Record<string, unknown>, file: string, expected: string) => {
    const outcome = rust(binary, { ...input, home: rsHome });
    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(rsHome, file), "utf8")).toBe(expected);
  };
  step({ op: "routing.set", rules: [{ kinds: ["docs"], executors: ["cursor", "codex"] }, { executors: ["codex"] }] }, "strategy.yaml", golden.routing);
  step({ op: "runner.reorder", ids: ["cursor", "codex"] }, "strategy.yaml", golden.reorder);
  step({ op: "runner.set", id: "codex", options: { enabled: false, model: "model-x", max_tasks: 2, rank: 0 } }, "strategy.yaml", golden.set);
  step({ op: "runner.remove", id: "cursor" }, "strategy.yaml", golden.remove);
  step({ op: "notifications.set", level: "all" }, "settings.json", golden.notifications);
  step({ op: "strategy.save", name: "review", draft: { from: "default", set: { "pacing.planner_reserve": 25 } }, reason: "Approved", who: "Codex", nowIso: "2026-10-10T12:00:00.000Z" }, "strategies/review.yaml", golden.save);
});

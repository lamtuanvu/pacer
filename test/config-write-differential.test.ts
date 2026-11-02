import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPS } from "../src/api/ops";
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

function home(initial = yaml) {
  const dir = mkdtempSync(join(tmpdir(), "pacer-config-diff-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "strategy.yaml"), initial, { mode: 0o600 });
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
  }
}, 30_000);

test("notification settings preserve enumerable JSON properties", () => {
  const binary = configBinary();
  for (const input of ['{"other":42}', '["alpha","beta"]', '"a😀b"', '{"literal":"\\\\ud800","pair":"\\ud83d\\ude00"}', '42', 'null', '{broken', '{"x":01}', '{"x":1e+}', '{"other":42,"huge":1e400,"negative":-1e999,"nested":[1.0,1e2,9007199254740993,1e-324,5e-324,1e-7,1e-6,-0,1e21,1e20,1.7976931348623157e308,1.7976931348623159e308]}', '[1e400,{"x":9007199254740993}]', '{"2":"b","1":"a","x":{"10":10,"2":2,"01":1,"4294967295":3,"0":0},"01":4,"4294967294":5,"4294967295":6}']) {
    for (const op of ["get", "set"] as const) {
      const tsHome = home(), rsHome = home();
      writeFileSync(join(tsHome, "settings.json"), input);
      writeFileSync(join(rsHome, "settings.json"), input);
      const ctx = fakeCtx({ pacerHome: tsHome });
      const expected = op === "get" ? notify.getLevel(ctx) : notify.setLevel(ctx, "all");
      const actual = rust(binary, op === "get"
        ? { op: "notifications.get", home: rsHome, legacyPluginData: join(rsHome, "missing") }
        : { op: "notifications.set", home: rsHome, level: "all" });
      expect(actual).toEqual({ ok: true, value: expected });
      expect(readFileSync(join(rsHome, "settings.json"), "utf8")).toBe(readFileSync(join(tsHome, "settings.json"), "utf8"));
    }
  }
}, 30_000);

test("notification writes refuse unsupported surrogate JSON without losing data", () => {
  const binary = configBinary();
  for (const input of ['{"other":42,"nested":{"bad":"\\ud800"}}', '{"array":["\\udfff"]}', '"\\ud800"', '"\\udfff"', '{"huge":1e400,"bad":"\\ud800"}', '{"bad":"\\udfff","huge":-1e400}']) {
    for (const op of ["get", "set"] as const) {
      const tsHome = home(), rsHome = home();
      writeFileSync(join(tsHome, "settings.json"), input);
      writeFileSync(join(rsHome, "settings.json"), input);
      const ctx = fakeCtx({ pacerHome: tsHome });
      if (op === "get") notify.getLevel(ctx); else notify.setLevel(ctx, "all");
      expect(JSON.parse(readFileSync(join(tsHome, "settings.json"), "utf8"))).toHaveProperty("notifications");
      const actual = rust(binary, op === "get"
        ? { op: "notifications.get", home: rsHome, legacyPluginData: join(rsHome, "missing") }
        : { op: "notifications.set", home: rsHome, level: "all" });
      expect(actual.ok).toBe(false);
      expect(readFileSync(join(rsHome, "settings.json"), "utf8")).toBe(input);
    }
  }
}, 30_000);

test("notification writes decode malformed UTF-8 before preserving settings", () => {
  const binary = configBinary();
  const bytes = (prefix: string, invalid: number[], suffix: string) => Buffer.concat([Buffer.from(prefix), Buffer.from(invalid), Buffer.from(suffix)]);
  const inputs = [
    bytes('{"other":42,"bad":"', [0xff], '"}'),
    bytes('{"nested":' + '['.repeat(140) + '{"bad":"', [0xe2, 0x82, 0x78], '"}' + ']'.repeat(140) + ',"other":42}'),
    bytes('{"bad":"', [0xf0, 0x9f, 0x98], '","other":42}'),
    bytes('{"', [0xc0, 0xaf], '":"value","other":42}'),
  ];
  for (const input of inputs) for (const op of ["get", "set"] as const) {
    const tsHome = home(), rsHome = home();
    writeFileSync(join(tsHome, "settings.json"), input);
    writeFileSync(join(rsHome, "settings.json"), input);
    const ctx = fakeCtx({ pacerHome: tsHome });
    const expected = op === "get" ? notify.getLevel(ctx) : notify.setLevel(ctx, "all");
    const actual = rust(binary, op === "get"
      ? { op: "notifications.get", home: rsHome, legacyPluginData: join(rsHome, "missing") }
      : { op: "notifications.set", home: rsHome, level: "all" });
    expect(actual).toEqual({ ok: true, value: expected });
    expect(readFileSync(join(rsHome, "settings.json"))).toEqual(readFileSync(join(tsHome, "settings.json")));
  }
  const unsupported = bytes('{"nested":' + '['.repeat(140) + '{"bad":"', [0xff], '","surrogate":"\\ud800"}' + ']'.repeat(140) + ',"other":42}');
  const rsHome = home();
  const path = join(rsHome, "settings.json");
  writeFileSync(path, unsupported);
  expect(rust(binary, { op: "notifications.set", home: rsHome, level: "all" }).ok).toBe(false);
  expect(readFileSync(path)).toEqual(unsupported);
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
  let seed = 0x574c02;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let i = 0; i < 32; i++) {
    const reserve = [10, 15, 25, 30][next() % 4]!;
    const probe = ["ask", "auto", "off"][next() % 3]!;
    const order = next() & 1 ? ["codex", "cursor"] : ["cursor", "codex"];
    drafts.push({
      from: "default",
      description: next() & 1 ? "" : `Review ${i}`,
      set: { "pacing.planner_reserve": reserve, "pacing.planner_probe": probe, "pacing.order": order },
    });
  }
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

test("runner.set numeric inputs match direct writes and the API boundary", async () => {
  const binary = configBinary();
  const literals = ["1", "1.0", "1e0", "1e2", "-0", "-1", "0.5", "9007199254740991", "9007199254740992", "1e21", '"1"', "null"];
  for (const field of ["rank", "max_tasks"] as const) for (const literal of literals) {
    const tsHome = home(), rsHome = home(), ctx = fakeCtx({ pacerHome: tsHome });
    const value = JSON.parse(literal);
    const options = { [field]: value };
    const api = OPS["runner.set"]!.params.safeParse({ id: "codex", ...options });
    const apiExpected = typeof value === "number" && Number.isSafeInteger(value) && (field === "rank" ? value >= 0 : value > 0);
    expect(api.success).toBe(apiExpected);
    let ts: unknown;
    try { ts = { ok: true, value: await runners.set(ctx, "codex", options) }; }
    catch (error) { ts = { ok: false, error: (error as Error).message }; }
    const raw = `{"op":"runner.set","home":${JSON.stringify(rsHome)},"id":"codex","options":{"${field}":${literal}}}\n`;
    const rs = JSON.parse(execFileSync(binary, [], { input: raw }).toString());
    expect(result(rs, rsHome)).toEqual(result(ts, tsHome));
    expect(readFileSync(join(rsHome, "strategy.yaml"))).toEqual(readFileSync(join(tsHome, "strategy.yaml")));
  }
}, 30_000);

test("runner references resolve like TypeScript across mutation and routing", async () => {
  const binary = configBinary();
  const aliased = yaml.replace("  codex: {} # keep runner", "  fast: {agent: codex, account: codex} # keep runner");
  const cases = [
    { op: "runner.set", id: "codex", options: { enabled: false } },
    { op: "runner.set", id: "codex#codex", options: { enabled: false } },
    { op: "runner.set", id: "codex#codex@local", options: { enabled: false } },
    { op: "runner.set", id: "codex@missing", options: { enabled: false } },
    { op: "runner.set", id: "fast", options: { enabled: false }, initial: aliased },
    { op: "runner.remove", id: "cursor#cursor" },
    { op: "runner.remove", id: "cursor#cursor@local" },
    { op: "runner.remove", id: "fast", initial: aliased },
    { op: "runner.remove", id: "cursor@missing" },
    { op: "runner.remove", id: "cursor#missing" },
    { op: "routing.set", rules: [{ kinds: ["docs"], executors: ["codex#codex@local"] }, { executors: ["cursor#cursor"] }] },
  ] as const;
  for (const input of cases) {
    const tsHome = home("initial" in input ? input.initial : yaml), rsHome = home("initial" in input ? input.initial : yaml);
    const ctx = fakeCtx({ pacerHome: tsHome });
    let ts: unknown;
    try {
      ts = { ok: true, value: input.op === "runner.set" ? await runners.set(ctx, input.id, input.options)
        : input.op === "runner.remove" ? await runners.remove(ctx, input.id) : await routing.set(ctx, structuredClone(input.rules) as unknown as Parameters<typeof routing.set>[1]) };
    } catch (error) { ts = { ok: false, error: (error as Error).message }; }
    const rs = rust(binary, { ...input, home: rsHome });
    expect(result(rs, rsHome)).toEqual(result(ts, tsHome));
    expect(readFileSync(join(rsHome, "strategy.yaml"), "utf8")).toBe(readFileSync(join(tsHome, "strategy.yaml"), "utf8"));
  }
}, 30_000);

test("generated string corpus matches Bun YAML bytes and saved strategies re-read", () => {
  const binary = configBinary();
  const fixed = ["with \"quote\"", "line\nbreak", "true", "null", "~", "on", "yes", "123", "1.0", "01", "0x10", ".nan", "+2", "a#b", "a #b", " leading", "trailing ", "éclair", "雪", "😀", "tab\there", "single'quote", "a,b", "a\nb\n", "", "colon:", "0b10", "0o12", "-0", "+0", "1e2", "NaN", "Infinity", "y", "n", "True", "NULL", "a\u0000b", "a\u001fb", "a\u0085b", "a\u2028b", "a\u2029b", ".5", "-.5", "1_000", "1.2.3", ".inf", "-.inf", "+.nan", "0Xff", "0O77", "2026-01-01", "a\\b", "a: b", "[abc]", "{abc}"];
  let seed = 0x5745a11;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const alphabet = ["a", "0", " ", ":", "#", "'", "\"", "\n", "\t", "é", "雪", "_", "-", ",", "[", "]", ".", "+", "\\"];
  const corpus = [...fixed];
  for (let n = -20; n <= 20; n++) corpus.push(`${n}`, `+${Math.abs(n)}`, `${n}.0`, `${n}e2`, `${n}e-2`, `${n}_000`);
  for (const prefix of ["0x", "0X", "0o", "0O", "0b", "0B"]) for (const suffix of ["0", "1", "10", "ff", "77"]) corpus.push(prefix + suffix);
  for (const mark of [":", "#", ",", "'", "\"", "[", "]", "{", "}", "`", "?", "-", "+", "%", "@", "!", "&", "*", "|"]) corpus.push(mark, mark + "a", "a" + mark, "a" + mark + "b");
  for (let i = 0; i < 512; i++) corpus.push(Array.from({ length: 1 + next() % 16 }, () => alphabet[next() % alphabet.length]).join(""));
  const ascii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32));
  corpus.push(...ascii, ...ascii.flatMap(a => ascii.map(b => a + b)));
  for (let code = 0; code <= 0x9f; code++) corpus.push(String.fromCharCode(code), `a${String.fromCharCode(code)}b`);
  const input = corpus.map(value => JSON.stringify({ op: "yaml.stringify", value: { execution: { base_branch: value } } })).join("\n") + "\n";
  const outputs = execFileSync(binary, [], { input, maxBuffer: 20 * 1024 * 1024 }).toString().trimEnd().split("\n");
  expect(outputs.length).toBe(corpus.length);
  for (const [index, value] of corpus.entries()) {
    const mapping = { execution: { base_branch: value } };
    const ts = Bun.YAML.stringify(mapping, null, 2).replace(/\n?$/, "\n");
    const rs = JSON.parse(outputs[index]!);
    expect(rs.value).toBe(ts);
  }
  for (const value of fixed) {
    const tsHome = home(), rsHome = home();
    const ctx = fakeCtx({ pacerHome: tsHome });
    const draft: strategy.Draft = { from: "default", set: { "execution.base_branch": value } };
    let ts: unknown;
    try { ts = { ok: true, value: strategy.save(ctx, "review", draft, "approved") }; }
    catch (error) { ts = { ok: false, error: (error as Error).message }; }
    const rs = rust(binary, { op: "strategy.save", home: rsHome, name: "review", draft, reason: "approved", nowIso: new Date(ctx.now * 1000).toISOString() });
    expect(result(rs, rsHome)).toEqual(result(ts, tsHome));
    if ((ts as {ok:boolean}).ok) {
      expect(readFileSync(join(rsHome, "strategies", "review.yaml"), "utf8")).toBe(readFileSync(join(tsHome, "strategies", "review.yaml"), "utf8"));
      expect(strategy.show(fakeCtx({ pacerHome: rsHome }), "review").yaml).toBe(readFileSync(join(rsHome, "strategies", "review.yaml"), "utf8"));
    }
  }
}, 30_000);

test("Rust state writers tighten file and directory modes under both umasks", async () => {
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
      expect(statSync(join(rsHome, "settings.json")).mode & 0o777).toBe(0o600);
      const tsSave = strategy.save(ctx, "review", { from: "default", description: "" }, "approved");
      const rsSave = rust(binary, { op: "strategy.save", home: rsHome, name: "review", draft: { from: "default", description: "" }, reason: "approved", nowIso: new Date(ctx.now * 1000).toISOString() });
      expect(result(rsSave, rsHome)).toEqual(result({ ok: true, value: tsSave }, tsHome));
      expect(statSync(join(rsHome, "strategies")).mode & 0o777).toBe(0o700);
      expect(statSync(join(rsHome, "strategies", "review.yaml")).mode & 0o777).toBe(0o600);
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
      expect(statSync(join(rsHome, "settings.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(rsHome, "strategies")).mode & 0o777).toBe(0o700);
      expect(statSync(join(rsHome, "strategies", "review.yaml")).mode & 0o777).toBe(0o600);
      const tsRunner = await runners.set(ctx, "codex", { rank: 1 });
      const rsRunner = rust(binary, { op: "runner.set", home: rsHome, id: "codex", options: { rank: 1 } });
      expect(rsRunner.ok).toBe(true);
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

test("strategy save reason uses the JavaScript trim character set", () => {
  const binary = configBinary();
  const whitespace = ["\t", "\n", "\v", "\f", "\r", " ", "\u00a0", "\u1680",
    ...Array.from({ length: 11 }, (_, i) => String.fromCodePoint(0x2000 + i)),
    "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"];
  for (const char of whitespace) {
    for (const reason of [char, `${char}approved${char}`]) {
      const tsHome = home(), rsHome = home();
      const ctx = fakeCtx({ pacerHome: tsHome });
      let ts: unknown;
      try { ts = { ok: true, value: strategy.save(ctx, "review", { from: "default" }, reason) }; }
      catch (error) { ts = { ok: false, error: (error as Error).message }; }
      const rs = rust(binary, { op: "strategy.save", home: rsHome, name: "review", draft: { from: "default" },
        reason, nowIso: new Date(ctx.now * 1000).toISOString() });
      expect(result(rs, rsHome)).toEqual(result(ts, tsHome));
      if ((ts as {ok: boolean}).ok) expect(readFileSync(join(rsHome, "strategies/review.yaml"), "utf8"))
        .toBe(readFileSync(join(tsHome, "strategies/review.yaml"), "utf8"));
    }
  }
});

test("strategy save headers preserve the same characters as TypeScript", () => {
  const binary = configBinary();
  for (const char of [...Array.from({length: 32}, (_, i) => String.fromCharCode(i)), "\u007f", "\u0085"]) {
    const tsHome = home(), rsHome = home(), ctx = fakeCtx({pacerHome: tsHome});
    const draft = {from: "default", description: `x${char}y`}, reason = `reason${char}end`;
    strategy.save(ctx, "review", draft, reason);
    rust(binary, {op: "strategy.save", home: rsHome, name: "review", draft, reason,
      nowIso: new Date(ctx.now * 1000).toISOString()});
    expect(readFileSync(join(rsHome, "strategies/review.yaml"))).toEqual(readFileSync(join(tsHome, "strategies/review.yaml")));
  }
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

test("raw integral JSON decimals stringify with JavaScript numeric bytes", () => {
  const binary = configBinary();
  const literals = ["1.0", "1e2", "-0.0", "9007199254740992", "9007199254740993", "9223372036854775807", "1e20", "1e21", "-1e21", "1e-7", "1.5"];
  const input = literals.map(literal => `{"op":"yaml.stringify","value":{"x":${literal}}}`).join("\n") + "\n";
  const output = execFileSync(binary, [], { input }).toString().trimEnd().split("\n");
  for (const [index, literal] of literals.entries()) {
    const value = JSON.parse(`{"x":${literal}}`);
    const expected = Bun.YAML.stringify(value, null, 2).replace(/\n?$/, "\n");
    expect(JSON.parse(output[index]!).value).toBe(expected);
  }
});

test("named strategy save normalizes raw JSON integral decimals in YAML", () => {
  const binary = configBinary();
  for (const literal of ["1.0", "1e2"]) {
    const tsHome = home(), rsHome = home();
    const ctx = fakeCtx({ pacerHome: tsHome });
    const draft = JSON.parse(`{"from":"default","set":{"pacing.planner_reserve":${literal}}}`) as strategy.Draft;
    let ts: unknown;
    try { ts = { ok: true, value: strategy.save(ctx, "review", draft, "approved") }; }
    catch (error) { ts = { ok: false, error: (error as Error).message }; }
    const raw = `{"op":"strategy.save","home":${JSON.stringify(rsHome)},"name":"review","draft":{"from":"default","set":{"pacing.planner_reserve":${literal}}},"reason":"approved","nowIso":${JSON.stringify(new Date(ctx.now * 1000).toISOString())}}\n`;
    const rs = JSON.parse(execFileSync(binary, [], { input: raw }).toString());
    expect(result(rs, rsHome)).toEqual(result(ts, tsHome));
    if ((ts as {ok: boolean}).ok) expect(readFileSync(join(rsHome, "strategies", "review.yaml"), "utf8"))
      .toBe(readFileSync(join(tsHome, "strategies", "review.yaml"), "utf8"));
  }
});

test("numeric draft fields preserve saved YAML bytes across runtimes", () => {
  const binary = configBinary();
  // Draft paths permit dispatch as a whole; its array members must be replaced together.
  const fields: [string, (value: unknown) => Record<string, unknown>][] = [
    ...["planner_reserve", "planner_reserve_headroom", "ahead_threshold", "behind_threshold"].map(key => [`pacing.${key}`, (value: unknown) => ({ [`pacing.${key}`]: value })] as [string, (value: unknown) => Record<string, unknown>]),
    ...["timeoutMs", "reservePct", "comfortablePct"].map(key => [`dispatch.${key}`, (value: unknown) => ({ dispatch: { [key]: value } })] as [string, (value: unknown) => Record<string, unknown>]),
    ...["minSamples", "maxAgeDays"].map(key => [`dispatch.learning.${key}`, (value: unknown) => ({ dispatch: { learning: { [key]: value } } })] as [string, (value: unknown) => Record<string, unknown>]),
    ["providers.codex.budget.weekly_tokens", value => ({ "providers.codex.budget.weekly_tokens": value })],
    ["providers.codex.cooldown", value => ({ "providers.codex.cooldown": value })],
    ["dispatch.steps.require.context", value => ({ dispatch: { steps: [{ id: "step", require: { context: value } }] } })],
    ...["timeout_ms", "bench.timeout_ms", "adapters.ollama.max_tokens", "adapters.jev.usd_per_mtok_in", "adapters.jev.usd_per_mtok_out", "decisions.difficulty.min_confidence", "decisions.difficulty.max_for_cheap"].map(key => [`classifier.${key}`, (value: unknown) => ({ [`classifier.${key}`]: value })] as [string, (value: unknown) => Record<string, unknown>]),
  ];
  const literals = ["1", "1.0", "1e0", "1e2", "-0", "-1", "0.5", "9007199254740991", "9007199254740992", "1e21", "-4.3167578921162367e-17", '"1"', "null"];
  let numericSeed = 0x39abc123;
  for (let i = 0; i < 64; i++) {
    numericSeed ^= numericSeed << 13; numericSeed ^= numericSeed >>> 17; numericSeed ^= numericSeed << 5;
    literals.push(String((numericSeed >>> 0) / 0x100000000 * 10 ** ((i % 31) - 20)));
  }
  for (const [label, makeSet] of fields) for (const literal of literals) {
    const tsHome = home(), rsHome = home(), ctx = fakeCtx({ pacerHome: tsHome });
    const set = makeSet("__NUMBER__");
    const rawSet = JSON.stringify(set).replace('"__NUMBER__"', literal);
    const draft = { from: "default", set: JSON.parse(rawSet) } as strategy.Draft;
    let ts: unknown;
    try { ts = { ok: true, value: strategy.save(ctx, "review", draft, "approved") }; }
    catch (error) { ts = { ok: false, error: (error as Error).message }; }
    const raw = `{"op":"strategy.save","home":${JSON.stringify(rsHome)},"name":"review","draft":{"from":"default","set":${rawSet}},"reason":"approved","nowIso":${JSON.stringify(new Date(ctx.now * 1000).toISOString())}}\n`;
    const rs = JSON.parse(execFileSync(binary, [], { input: raw }).toString());
    try {
      expect(result(rs, rsHome)).toEqual(result(ts, tsHome));
      if ((ts as {ok: boolean}).ok) expect(readFileSync(join(rsHome, "strategies/review.yaml"))).toEqual(readFileSync(join(tsHome, "strategies/review.yaml")));
    } catch (error) { throw new Error(`${label}=${literal}: ${error}`); }
  }
}, 60_000);

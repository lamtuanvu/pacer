import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { save } from "../src/strategy/service";
import { fakeCtx } from "./helpers";
import { validateStrategy, StrategyError } from "../src/config/strategy";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Outcome = { ok: true; value: Json } | { ok: false; code: "invalid"; problems: string[] };
const fixture = JSON.parse(readFileSync("test/fixtures/strategy-read/cases.json", "utf8")) as { name: string; raw: Json; expected?: Json }[];
const bases = ["simple-legacy", "host-defaults", "endpoint-connection", "remote-headless-session-control"]
  .map(name => fixture.find(c => c.name === name)!.raw);
const seed = 0x554ff02;
let state = seed;

test("review boundary goldens still match TypeScript", () => {
  const cases = JSON.parse(readFileSync("test/fixtures/strategy-read/boundaries.json", "utf8")) as
    { name: string; raw: Json; expected?: Json; problems?: string[] }[];
  for (const item of cases) {
    const result = (() => {
      try { return { expected: validateStrategy(item.raw, "strategy.yaml", item.name) as unknown as Json }; }
      catch (error) { if (error instanceof StrategyError) return { problems: error.problems }; throw error; }
    })();
    if (canonical(result) !== canonical(item.expected === undefined ? { problems: item.problems } : { expected: item.expected })) {
      throw Error(`Stale TypeScript boundary golden: ${item.name}`);
    }
  }
});
function random(): number { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; }
function pick<T>(values: readonly T[]): T { return values[random() % values.length]!; }
function clone<T>(value: T): T { return structuredClone(value); }
function paths(value: Json, path: (string | number)[] = []): (string | number)[][] {
  if (value === null || typeof value !== "object") return [path];
  const children = Object.entries(value).flatMap(([key, child]) => paths(child, [...path, Array.isArray(value) ? Number(key) : key]));
  return [path, ...children];
}
function at(root: Json, path: (string | number)[]): Json {
  return path.reduce<Json>((value, key) => (value as Record<string, Json>)[key]!, root);
}
function set(root: Json, path: (string | number)[], value: Json, remove = false): Json {
  if (!path.length) return remove ? null : value;
  const parent = at(root, path.slice(0, -1)) as Record<string, Json>;
  const key = String(path.at(-1));
  if (remove) delete parent[key]; else parent[key] = value;
  return root;
}
const strings = ["", "a", "e", "é", "😀", "a".repeat(64), "a".repeat(65), "localhost", "127.0.0.1", "[::1]", "bücher.de", "example.com:8080", "http://%", "http://exa%mple.com", "http://localhost:abc", "http://localhost:65536", "http://localhost:0", "http:localhost", "HTTP://LOCALHOST", " http://localhost ", "http://localhost", "https://127.0.0.1:8080/v1", "http://user@localhost", "http://[::1]:80", "http://[::1]", "http://127.0.0.1", "http://user:pass@localhost", "http://bücher.de", "localhost/owner/repo", "127.0.0.1/a/b", "bücher.de/a/b", "[::1]/a/b", "example.com:8080/a/b", "user@localhost/a/b", "localhost:8080/a/b", "example.com/a/b.git", "EXAMPLE.com/a/b", "a/b/c"];
const values: Json[] = [null, true, false, 0, 1, -1, 1.5, [], {}, ...strings];
function mutate(base: Json, index: number): Json {
  let raw = clone(base);
  const count = index % 11 === 0 ? 3 : index % 5 === 0 ? 2 : 1;
  for (let n = 0; n < count; n++) {
    const all = paths(raw);
    const path = pick(all);
    const old = at(raw, path);
    const mode = random() % 6;
    if (mode === 0 && path.length) raw = set(raw, path, null, true);
    else if (mode === 1 && old && typeof old === "object" && !Array.isArray(old)) {
      (old as Record<string, Json>)[pick(["unknown", "extra", "x", "connection", "models", "kind"])] = pick(values);
    } else if (mode === 2 && path.length && typeof path.at(-1) === "string") {
      const parent = at(raw, path.slice(0, -1)) as Record<string, Json>;
      const key = String(path.at(-1));
      parent[pick(strings)] = parent[key]!;
      delete parent[key];
    } else raw = set(raw, path, pick(values));
  }
  return raw;
}
function directed(): Json[] {
  const cases: Json[] = [];
  // Exercise every fixture field with boundary strings and representative wrong types.
  for (const base of bases) {
    for (const path of paths(base).filter(path => path.length)) {
      for (const value of values) {
        cases.push(set(clone(base), path, value));
      }
      cases.push(set(clone(base), path, null, true));
    }
  }
  const endpoint = bases[2]!;
  for (const name of strings) {
    const raw = clone(endpoint) as Record<string, Json>;
    const accounts = raw.accounts as Record<string, Json>;
    accounts[name] = accounts.edge!;
    delete accounts.edge;
    ((raw.runners as Record<string, Json>).edge as Record<string, Json>).account = name;
    cases.push(raw);
  }
  const host = bases[1]!;
  for (const key of strings) {
    const raw = clone(host) as Record<string, Json>;
    const hosts = raw.hosts as Record<string, Json>;
    const entry = hosts[Object.keys(hosts)[0]!] as Record<string, Json>;
    entry.repos = { [key]: "/tmp/repo" };
    cases.push(raw);
  }
  return cases;
}
function ts(raw: Json): Outcome {
  try { return { ok: true, value: validateStrategy(raw, "strategy.yaml", "differential") as unknown as Json }; }
  catch (error) { if (error instanceof StrategyError) return { ok: false, code: "invalid", problems: error.problems }; throw error; }
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
}
function rust(binary: string, inputs: Json[]): Outcome[] {
  const run = spawnSync(binary, { input: inputs.map(x => JSON.stringify(x)).join("\n") + "\n", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw Error(`Rust validator failed: ${run.stderr}`);
  return run.stdout.trimEnd().split("\n").map(x => JSON.parse(x) as Outcome);
}
function minimize(binary: string, document: Json): Json {
  let current = clone(document);
  let changed = true;
  while (changed) {
    changed = false;
    for (const path of paths(current).filter(p => p.length).sort((a, b) => a.length - b.length)) {
      const candidate = clone(current);
      set(candidate, path, null, true);
      const normalized = JSON.parse(JSON.stringify(candidate)) as Json;
      if (canonical(ts(normalized)) !== canonical(rust(binary, [normalized])[0])) {
        current = normalized;
        changed = true;
        break;
      }
    }
  }
  return current;
}

test("seeded TypeScript and Rust strategy validators agree", () => {
  const built = spawnSync("cargo", ["build", "-q", "-p", "pacer-config", "--example", "strategy_diff", "--locked"], { encoding: "utf8" });
  if (built.status !== 0) throw Error(`Rust test binary build failed: ${built.stderr}`);
  const binary = "target/debug/examples/strategy_diff";
  const requested = Number(process.env.STRATEGY_DIFF_COUNT ?? 3000);
  if (!Number.isSafeInteger(requested) || requested < 1) throw Error("STRATEGY_DIFF_COUNT must be a positive integer");
  const cases = directed();
  const inputs = Array.from({ length: requested }, (_, i) =>
    JSON.parse(JSON.stringify(i < cases.length ? cases[i]! : mutate(bases[i % bases.length]!, i))) as Json);
  const expected = inputs.map(ts);
  const actual = rust(binary, inputs);
  if (actual.length !== requested) throw Error(`Rust returned ${actual.length} of ${requested} results`);
  const mismatch = actual.findIndex((result, i) => canonical(result) !== canonical(expected[i]));
  if (mismatch >= 0) {
    const minimal = minimize(binary, inputs[mismatch]!);
    throw Error(`Strategy differential mismatch at case ${mismatch + 1}/${requested}, seed ${seed}:\n${JSON.stringify(minimal, null, 2)}\nTS ${canonical(ts(minimal))}\nRust ${canonical(rust(binary, [minimal])[0])}`);
  }
  console.log(`Strategy differential: ${requested} cases, seed ${seed}, zero divergences`);
}, 60_000);

function rawRust(binary: string, inputs: string[]): Outcome[] {
  const run = spawnSync(binary, { input: inputs.join("\n") + "\n", encoding: "utf8" });
  if (run.status !== 0) throw Error(`Rust validator failed: ${run.stderr}`);
  return run.stdout.trimEnd().split("\n").map(line => JSON.parse(line) as Outcome);
}

function fieldCase(base: Json, path: (string | number)[], value: Json): Json {
  const raw = clone(base) as Record<string, Json>;
  let current: Record<string, Json> = raw;
  for (let i = 0; i < path.length - 1; i++) {
    const key = String(path[i]);
    if (current[key] === undefined) current[key] = typeof path[i + 1] === "number" ? [] : {};
    current = current[key] as Record<string, Json>;
  }
  current[String(path.at(-1))] = value;
  return raw;
}

test("JavaScript trim boundaries match Rust for scoped strategy fields", () => {
  const built = spawnSync("cargo", ["build", "-q", "-p", "pacer-config", "--example", "strategy_diff", "--locked"], { encoding: "utf8" });
  if (built.status !== 0) throw Error(`Rust test binary build failed: ${built.stderr}`);
  const binary = "target/debug/examples/strategy_diff";
  const whitespace = ["\t", "\n", "\v", "\f", "\r", " ", "\u00a0", "\u1680",
    ...Array.from({ length: 11 }, (_, i) => String.fromCodePoint(0x2000 + i)),
    "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff"];
  const fields: {label: string; base: Json; path: (string | number)[]; good: string}[] = [
    { label: "model id", base: bases[2]!, path: ["accounts", "edge", "connection", "models", 0, "id"], good: "fast" },
    { label: "model name", base: bases[2]!, path: ["accounts", "edge", "connection", "models", 0, "name"], good: "Fast" },
    { label: "account home", base: bases[2]!, path: ["accounts", "codex", "home"], good: "/tmp/codex" },
    { label: "account orca", base: bases[2]!, path: ["accounts", "codex", "orca_account"], good: "work" },
    { label: "host repo", base: bases[1]!, path: ["hosts", "build", "repos", "github.com/org/repo"], good: "/srv/repo" },
    { label: "host account", base: bases[1]!, path: ["hosts", "build", "accounts", "work", "home"], good: "/srv/codex" },
    { label: "weekly tokens", base: bases[2]!, path: ["accounts", "edge", "budget", "weekly_tokens"], good: "1k" },
    { label: "cooldown", base: bases[2]!, path: ["accounts", "edge", "cooldown"], good: "1h" },
  ];
  const cases = fields.flatMap(field => whitespace.flatMap(char => [char, `${char}${field.good}${char}`]
    .map(value => ({ label: `${field.label} U+${char.codePointAt(0)!.toString(16)} ${JSON.stringify(value)}`,
      raw: fieldCase(field.base, field.path, value) }))));
  const actual = rust(binary, cases.map(item => item.raw));
  for (const [i, item] of cases.entries()) {
    const expected = ts(item.raw);
    if (canonical(actual[i]) !== canonical(expected)) throw Error(`${item.label}: TS ${canonical(expected)} Rust ${canonical(actual[i])}`);
  }
});

test("raw JSON number and Unicode length boundaries match TypeScript for every config field", () => {
  const built = spawnSync("cargo", ["build", "-q", "-p", "pacer-config", "--example", "strategy_diff", "--locked"], { encoding: "utf8" });
  if (built.status !== 0) throw Error(`Rust test binary build failed: ${built.stderr}`);
  const binary = "target/debug/examples/strategy_diff";
  const base = bases[0]!;
  const endpoint = bases[2]!;
  const runner = fieldCase(bases[3]!, ["runners", "codex@box", "models"], [{ id: "fast" }]);
  const dispatch = fieldCase(base, ["dispatch", "steps"], [{ id: "step" }]);
  const messaging = fieldCase(base, ["messaging"], {});
  const numberFields: { label: string; base: Json; path: (string | number)[]; validZero?: boolean; safe?: boolean }[] = [
    { label: "endpoint context", base: endpoint, path: ["accounts", "edge", "connection", "models", 0, "context"], safe: true },
    { label: "endpoint output", base: endpoint, path: ["accounts", "edge", "connection", "models", 0, "output"], safe: true },
    { label: "runner max_tasks", base: endpoint, path: ["runners", "edge", "max_tasks"] },
    { label: "host max_tasks", base: bases[1]!, path: ["hosts", "build", "max_tasks"] },
    { label: "runner model context", base: runner, path: ["runners", "codex@box", "models", 0, "context"], safe: true },
    { label: "runner model output", base: runner, path: ["runners", "codex@box", "models", 0, "output"], safe: true },
    { label: "local max tasks", base, path: ["execution", "local_max_tasks"], safe: true },
    { label: "idle after", base, path: ["execution", "idle_after_min"] },
    { label: "idle fail", base, path: ["execution", "idle_fail_min"] },
    { label: "session log", base, path: ["execution", "session_log_mb"] },
    { label: "session retention", base, path: ["execution", "session_retention_days"] },
    { label: "task retention", base, path: ["task_retention_days"], safe: true, validZero: true },
    { label: "dispatch timeout", base: dispatch, path: ["dispatch", "timeoutMs"], safe: true },
    { label: "dispatch learning samples", base: dispatch, path: ["dispatch", "learning", "minSamples"], safe: true },
    { label: "dispatch learning age", base: dispatch, path: ["dispatch", "learning", "maxAgeDays"], safe: true },
    { label: "dispatch required context", base: dispatch, path: ["dispatch", "steps", 0, "require", "context"], safe: true },
    { label: "messaging keep days", base: messaging, path: ["messaging", "keep_worktree_days"], safe: true, validZero: true },
    { label: "messaging max bytes", base: messaging, path: ["messaging", "message", "max_bytes"], safe: true },
    { label: "messaging max turns", base: messaging, path: ["messaging", "tree", "max_turns"], safe: true },
    { label: "messaging interval", base: messaging, path: ["messaging", "liveness", "interval_s"], safe: true },
    { label: "messaging backoff", base: messaging, path: ["messaging", "liveness", "backoff_max_s"], safe: true },
    { label: "messaging nudges", base: messaging, path: ["messaging", "liveness", "max_nudges"], safe: true, validZero: true },
    { label: "messaging escalation", base: messaging, path: ["messaging", "liveness", "escalate_after_s"], safe: true },
    { label: "messaging stop release", base: messaging, path: ["messaging", "hooks", "stop_release_after"], safe: true },
    { label: "messaging rule per minute", base: fieldCase(messaging, ["messaging", "rules"], [{ effect: "allow", limits: {} }]), path: ["messaging", "rules", 0, "limits", "per_minute"], safe: true },
    { label: "messaging rule max bytes", base: fieldCase(messaging, ["messaging", "rules"], [{ effect: "allow", limits: {} }]), path: ["messaging", "rules", 0, "limits", "max_bytes"], safe: true },
  ];
  const inputs: { label: string; raw: string; accepted?: boolean }[] = [];
  for (const field of numberFields) {
    const literals = ["1", "1.0", "1e0", "1e2", "-0", "-1", "0.5", "9007199254740991", "9007199254740992", "1e21", '"1"', "null"];
    for (const literal of literals) {
      const raw = JSON.stringify(fieldCase(field.base, field.path, "__RAW_NUMBER__")).replace('"__RAW_NUMBER__"', literal);
      inputs.push({ label: `${field.label}=${literal}`, raw });
    }
  }

  const finiteFields: { label: string; base: Json; path: (string | number)[]; accepted: string; rejected: string }[] = [
    { label: "weekly USD", base: endpoint, path: ["accounts", "edge", "budget", "weekly_usd"], accepted: "1.5", rejected: "0" },
    { label: "local load", base, path: ["execution", "local_load_limit"], accepted: "1.5", rejected: "0" },
    { label: "pacing fill", base, path: ["pacing", "fill_threshold"], accepted: "75.5", rejected: "49.5" },
    { label: "pacing reserve", base, path: ["pacing", "planner_reserve"], accepted: "25.5", rejected: "100" },
    { label: "pacing headroom", base, path: ["pacing", "planner_reserve_headroom"], accepted: "25.5", rejected: "100" },
    { label: "dispatch reserve", base: dispatch, path: ["dispatch", "reservePct"], accepted: "25.5", rejected: "100.5" },
    { label: "dispatch comfortable", base: dispatch, path: ["dispatch", "comfortablePct"], accepted: "25.5", rejected: "100.5" },
  ];
  for (const field of finiteFields) for (const literal of ["1", "1.0", "1e0", "1e2", "-0", "-1", "0.5", "9007199254740991", "9007199254740992", "1e21", '"1"', "null", field.accepted, field.rejected]) {
    const raw = JSON.stringify(fieldCase(field.base, field.path, "__RAW_NUMBER__")).replace('"__RAW_NUMBER__"', literal);
    inputs.push({ label: `${field.label}=${literal}`, raw });
  }
  // Saving an unchanged draft rewrites every numeric field in the base strategy.
  // Exercise persisted bytes as well as validation, including raw JSON exponents.
  execFileSync("cargo", ["build", "-q", "-p", "pacer-config", "--example", "config_write_diff", "--locked"]);
  for (const input of inputs) {
    const tsHome = mkdtempSync(join(tmpdir(), "pacer-save-ts-"));
    const rsHome = mkdtempSync(join(tmpdir(), "pacer-save-rs-"));
    for (const home of [tsHome, rsHome]) writeFileSync(join(home, "strategy.yaml"), input.raw);
    const ctx = fakeCtx({ pacerHome: tsHome });
    let ts: {ok: boolean; error?: string};
    try { save(ctx, "review", {from: "default", description: "numeric"}, "approved"); ts = {ok: true}; }
    catch (error) { ts = {ok: false, error: (error as Error).message}; }
    const rs = JSON.parse(execFileSync("target/debug/examples/config_write_diff", [], {input: JSON.stringify({op: "strategy.save", home: rsHome, name: "review", draft: {from: "default", description: "numeric"}, reason: "approved", nowIso: new Date(ctx.now * 1000).toISOString()}) + "\n"}).toString());
    if (rs.ok !== ts.ok || (!ts.ok && rs.error !== ts.error)) throw Error(`${input.label}: TS ${JSON.stringify(ts)} Rust ${JSON.stringify(rs)}`);
    if (ts.ok) {
      const tsBytes = readFileSync(join(tsHome, "strategies/review.yaml"));
      const rsBytes = readFileSync(join(rsHome, "strategies/review.yaml"));
      if (!tsBytes.equals(rsBytes)) throw Error(`${input.label}: saved bytes differ\nTS ${tsBytes}\nRust ${rsBytes}`);
    }
  }
  const names: { label: string; base: Json; path: (string | number)[] }[] = [
    { label: "runner model id", base: runner, path: ["runners", "codex@box", "models", 0, "id"] },
    { label: "runner model strength", base: fieldCase(runner, ["runners", "codex@box", "models", 0, "strengths"], ["x"]), path: ["runners", "codex@box", "models", 0, "strengths", 0] },
    { label: "dispatch step id", base: dispatch, path: ["dispatch", "steps", 0, "id"] },
    { label: "dispatch match kind", base: dispatch, path: ["dispatch", "steps", 0, "match", "kind"] },
    { label: "dispatch discovery runner", base: fieldCase(dispatch, ["dispatch", "discovery", "runners"], ["x"]), path: ["dispatch", "discovery", "runners", 0] },
    { label: "dispatch discovery model", base: fieldCase(dispatch, ["dispatch", "discovery", "models"], ["x"]), path: ["dispatch", "discovery", "models", 0] },
    { label: "dispatch preferred model", base: fieldCase(dispatch, ["dispatch", "steps", 0, "prefer", "models"], ["x"]), path: ["dispatch", "steps", 0, "prefer", "models", 0] },
    { label: "dispatch preferred strength", base: fieldCase(dispatch, ["dispatch", "steps", 0, "prefer", "strengths"], ["x"]), path: ["dispatch", "steps", 0, "prefer", "strengths", 0] },
    { label: "dispatch candidate model", base: fieldCase(dispatch, ["dispatch", "steps", 0, "candidates", "models"], ["x"]), path: ["dispatch", "steps", 0, "candidates", "models", 0] },
    { label: "dispatch candidate executor", base: fieldCase(dispatch, ["dispatch", "steps", 0, "candidates", "executors"], ["x"]), path: ["dispatch", "steps", 0, "candidates", "executors", 0] },
  ];
  for (const field of names) for (const length of [128, 256, 257]) {
    inputs.push({ label: `${field.label}=${length} emoji`, raw: JSON.stringify(fieldCase(field.base, field.path, "😀".repeat(length))), accepted: length <= 256 });
  }
  for (const count of [997, 998]) inputs.push({ label: `terminal.open=${count} emoji`, raw: JSON.stringify(fieldCase(base, ["terminal", "open"], "😀".repeat(count) + "{cmd}")), accepted: count === 997 });
  const actual = rawRust(binary, inputs.map(input => input.raw));
  for (const [index, input] of inputs.entries()) {
    let expected: unknown;
    try { expected = { ok: true, value: validateStrategy(JSON.parse(input.raw), "strategy.yaml", "differential") }; }
    catch (error) { expected = error instanceof StrategyError
      ? { ok: false, code: "invalid", problems: error.problems }
      : { ok: false, error: (error as Error).message }; }
    if (input.accepted !== undefined && (expected as {ok: boolean}).ok !== input.accepted) throw Error(`${input.label}: expected acceptance ${input.accepted}, got ${canonical(expected)}`);
    if (canonical(actual[index]) !== canonical(expected)) throw Error(`${input.label}: TS ${canonical(expected)} Rust ${canonical(actual[index])}`);
  }
}, 60_000);

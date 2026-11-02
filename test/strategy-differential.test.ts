import { beforeAll, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy, StrategyError } from "../src/config/strategy";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Outcome = { ok: true; value: Json } | { ok: false; code: "invalid"; problems: string[] };
const fixture = JSON.parse(readFileSync("test/fixtures/strategy-read/cases.json", "utf8")) as { name: string; raw: Json; expected?: Json }[];
const bases = ["simple-legacy", "host-defaults", "endpoint-connection", "remote-headless-session-control"]
  .map(name => fixture.find(c => c.name === name)!.raw);
const seed = 0x554ff02;
let state = seed;
const root = join(import.meta.dir, "..");
const binary = join(root, "target/debug/examples/strategy_diff");

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

beforeAll(() => {
  const built = spawnSync("cargo", ["build", "-q", "-p", "pacer-config", "--example", "strategy_diff", "--locked"], {
    cwd: root,
    encoding: "utf8",
    timeout: 600_000,
  });
  if (built.error || built.status !== 0) {
    throw Error(`Rust test binary build failed: ${built.error?.message ?? built.stderr}`);
  }
}, 600_000);

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
}, 30_000);

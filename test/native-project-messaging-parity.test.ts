import {expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {existsSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {callOp} from "../src/api/ops";
import {toApiError} from "../src/api/errors";
import {fakeCtx} from "./helpers";

let binary: string;
function driver() {
  if (!binary) {
    execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"]);
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"]).toString());
    binary = join(metadata.target_directory, "debug/examples/config_ops_diff");
  }
  return binary;
}
const FILE = "project-messaging.json";
const normalize = (value: unknown, path: string) => JSON.parse(JSON.stringify(value).replaceAll(path, "$HOME"));
const events = (path: string) => {
  if (!existsSync(join(path, "link/outbox.jsonl"))) return [];
  return readFileSync(join(path, "link/outbox.jsonl"), "utf8").trim().split("\n").map(line => {
    const entry = JSON.parse(line);
    if (entry.envelope.type === "entity" && entry.envelope.data.kind === "activity") { delete entry.envelope.data.id; delete entry.envelope.data.value.id; }
    return entry.envelope;
  });
};
async function compare(op: string, params: unknown, setup?: (home: string) => void, rawParams?: string) {
  const rs = mkdtempSync(join(tmpdir(), "native-pm-")), ts = mkdtempSync(join(tmpdir(), "native-pm-"));
  setup?.(rs); setup?.(ts);
  const ctx = fakeCtx({pacerHome: ts, home: ts, now: 1_700_000_000, env: {}});
  let expected: unknown;
  try { expected = {result: await callOp(ctx, op, params)}; } catch (error) { expected = {error: toApiError(error)}; }
  const input = `{"op":${JSON.stringify(op)},"params":${rawParams ?? JSON.stringify(params)},"home":${JSON.stringify(rs)},"now":${ctx.now}}\n`;
  const actual = JSON.parse(execFileSync(driver(), [], {input}).toString());
  const label = `${op} ${rawParams ?? JSON.stringify(params)}`;
  expect(normalize(actual, rs), `${label} actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`).toEqual(normalize(expected, ts));
  const read = (path: string) => existsSync(join(path, FILE)) ? readFileSync(join(path, FILE), "utf8") : null;
  expect(read(rs), `${label}: ${FILE}`).toBe(read(ts));
  expect(normalize(events(rs), rs), `${label}: events`).toEqual(normalize(events(ts), ts));
  return expected;
}

const repo = "github.com/acme/app";
// Stored keys out of schema order, integral floats and -0: TypeScript rewrites them normalized.
const existing = (path: string) => writeFileSync(join(path, FILE), JSON.stringify({projects: {
  "github.com/acme/other": {rev: 3.0, liveness: {max_nudges: 0, interval_s: 60}, rules: [{kinds: ["question"], effect: "deny", limits: {confirm: true, max_bytes: 1024.0}}]},
  [repo]: {max_turns: 7, rev: 1, rules: [{relation: "any", effect: "allow", from_kind: "human"}]},
}, version: 1}).replace('"max_nudges":0', '"max_nudges":-0'), {mode: 0o600});
const rule = {limits: {per_minute: 2, confirm: false}, executor: "codex#work@local", repo, grant: "required", kinds: ["message", "report"], relation: ["parent", "child"], from_position: "top", to_kind: "launched", from_kind: "any", effect: "deny"};

test("native project.messaging matches TypeScript results, file bytes and publication", async () => {
  const cases: [string, unknown, ((home: string) => void)?, string?][] = [
    ["project.messaging.get", {repo}],
    ["project.messaging.get", {repo}, existing],
    ["project.messaging.get", {repo: "github.com/acme/other"}, existing],
    ["project.messaging.get", {repo: "local:0123456789ab"}, existing],
    ["project.messaging.set", {repo, expect_rev: 0, rules: [rule], max_turns: 10000, liveness: {nudge_in_modes: ["strict", "emergency"], max_nudges: 0, backoff_max_s: 900.0, interval_s: 10}}],
    ["project.messaging.set", {repo, expect_rev: 0, rules: [], liveness: {}}],
    ["project.messaging.set", {repo, expect_rev: 1, rules: [rule]}, existing],
    ["project.messaging.set", {repo: "github.com/acme/new", expect_rev: 0, rules: [{effect: "allow"}]}, existing],
    ["project.messaging.set", {repo, expect_rev: 0, rules: []}, existing],
    ["project.messaging.set", {repo, expect_rev: 9007199254740991, rules: []}],
    ["project.messaging.remove", {repo, expect_rev: 1}, existing],
    ["project.messaging.remove", {repo, expect_rev: 0}],
    ["project.messaging.remove", {repo: "local:0123456789ab", expect_rev: 0}, existing],
    ["project.messaging.remove", {repo, expect_rev: 2}, existing],
    // Operation schema and repository-key errors.
    ["project.messaging.get", null, undefined, "null"],
    ["project.messaging.get", "x"],
    ["project.messaging.get", {}],
    ["project.messaging.get", {repo: ""}],
    ["project.messaging.get", {repo: "a".repeat(4097)}],
    ["project.messaging.get", {repo: "checkout"}],
    ["project.messaging.get", {repo: "GitHub.com/acme/app"}],
    ["project.messaging.get", {repo, extra: 1, other: 2}],
    ["project.messaging.remove", {repo, expect_rev: -1}],
    ["project.messaging.remove", {repo, expect_rev: 1.5}],
    ["project.messaging.remove", {repo, expect_rev: "1"}],
    ["project.messaging.remove", {repo, expect_rev: -9007199254740992}],
    ["project.messaging.remove", {repo, expect_rev: 1e300}],
    ["project.messaging.remove", {z: 1}],
    ["project.messaging.set", {b: 1, a: 2}],
    ["project.messaging.set", {repo, expect_rev: 0, rules: {}}],
    ["project.messaging.set", {repo, expect_rev: 0, rules: Array(51).fill({effect: "allow"})}],
    ["project.messaging.set", {repo, expect_rev: 0, rules: [], max_turns: 0}],
    ["project.messaging.set", {repo, expect_rev: 0, rules: [], max_turns: 10001}],
    ["project.messaging.set", {repo, expect_rev: 0, rules: [], max_turns: 2.5}],
    ["project.messaging.set", {repo, expect_rev: 0, rules: [], max_turns: null}],
    ["project.messaging.set", {repo, expect_rev: 0, rules: [], max_turns: -1e18}],
    ["project.messaging.set", {repo: "checkout", expect_rev: 0, rules: []}],
  ];
  for (const [op, params, setup, raw] of cases) await compare(op, params, setup, raw);
}, 600_000);

test("native project.messaging leaves Core-only inputs to TypeScript", async () => {
  // These inputs are forwarded: TypeScript alone reproduces the repository probe, Node read errors and Zod issue text.
  const invalid = (path: string) => writeFileSync(join(path, FILE), JSON.stringify({version: 1, projects: {[repo]: {rev: 1, rules: [{effect: "maybe"}]}}}));
  const home = mkdtempSync(join(tmpdir(), "native-pm-"));
  invalid(home);
  const ctx = fakeCtx({pacerHome: home, home, now: 1_700_000_000, env: {}});
  expect(await callOp(ctx, "project.messaging.get", {repo})).toMatchObject({rev: 0, error: expect.stringContaining("Invalid project messaging: projects.github.com/acme/app.rules.0.effect")});
  try { await callOp(ctx, "project.messaging.set", {repo, expect_rev: 0, rules: [{effect: "maybe"}]}); throw new Error("accepted"); }
  catch (error) { expect(toApiError(error).message).toStartWith("rules.0.effect: Invalid option"); }
});

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const script = resolve("scripts/ci/shard-tests.py");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(durations: Record<string, number>, manifest = "", extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "pacer-ci-shard-"));
  roots.push(root);
  for (const [path, body] of Object.entries({ ...Object.fromEntries(Object.keys(durations).map(name => [name, ""])), ...extra })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  writeFileSync(join(root, "durations.json"), JSON.stringify(durations));
  writeFileSync(join(root, "manifest.txt"), manifest);
  return root;
}

function run(root: string, env: Record<string, string> = {}, args: string[] = []) {
  const result = Bun.spawnSync(["python3", script, ...args], { cwd: root, env: { PATH: process.env.PATH!,
    SHARD_TIMINGS: join(root, "durations.json"), SHARD_MACOS_MANIFEST: join(root, "manifest.txt"), ...env } });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}
const shard = (root: string, index: number, count: number, env: Record<string, string> = {}) =>
  JSON.parse(run(root, { SHARD_INDEX: String(index), SHARD_COUNT: String(count), ...env }).out) as string[];
const shards = (root: string, count: number, env: Record<string, string> = {}) =>
  Array.from({ length: count }, (_, index) => shard(root, index, count, env));

const durations = { "test/a.test.ts": 10, "test/b.test.ts": 7, "test/c.test.ts": 6, "test/d.test.ts": 5, "test/e.test.tsx": 4, "test/f.test.ts": 3, "test/g.test.ts": 1 };

test("packing is deterministic and places every file exactly once", () => {
  const root = fixture(durations);
  const first = shards(root, 3);
  expect(shards(root, 3)).toEqual(first);
  expect(first.flat().sort()).toEqual(Object.keys(durations).sort());
});

test("packing balances by duration rather than by name", () => {
  const root = fixture(durations);
  const loads = shards(root, 3).map(files => files.reduce((sum, file) => sum + durations[file as keyof typeof durations], 0));
  expect(loads.sort((a, b) => b - a)).toEqual([13, 12, 11]);
});

test("the slowest file alone sets the floor for a shard", () => {
  const root = fixture({ "test/huge.test.ts": 100, "test/a.test.ts": 1, "test/b.test.ts": 1 });
  expect(shards(root, 2)).toContainEqual(["test/huge.test.ts"]);
});

test("a file without a recorded duration counts as the median", () => {
  const root = fixture({ "test/a.test.ts": 9, "test/b.test.ts": 5, "test/c.test.ts": 1 }, "", { "test/new.test.ts": "" });
  // At the median of 5 the new file fills the second shard, so the 1-second file joins the first.
  expect(shards(root, 2)).toEqual([["test/a.test.ts", "test/c.test.ts"], ["test/b.test.ts", "test/new.test.ts"]]);
});

test("only fully macOS files leave the Linux shards, and only when asked", () => {
  const manifest = "# comment\nonly test/a.test.ts\nmixed test/b.test.ts\nlinux test/c.test.ts\n";
  const root = fixture(durations, manifest);
  expect(shards(root, 2).flat()).toContain("test/a.test.ts");
  const linux = shards(root, 2, { SHARD_EXCLUDE_MACOS: "1" }).flat();
  expect(linux).not.toContain("test/a.test.ts");
  expect(linux).toEqual(expect.arrayContaining(["test/b.test.ts", "test/c.test.ts"]));
  expect(JSON.parse(run(root, {}, ["--macos"]).out)).toEqual(["test/a.test.ts", "test/b.test.ts"]);
});

test("invalid shard settings, durations and manifests fail", () => {
  const root = fixture(durations);
  for (const env of [{ SHARD_INDEX: "3", SHARD_COUNT: "3" }, { SHARD_INDEX: "0", SHARD_COUNT: "0" }, { SHARD_INDEX: "-1", SHARD_COUNT: "3" }]) {
    expect(run(root, env).code).not.toBe(0);
  }
  writeFileSync(join(root, "manifest.txt"), "sometimes test/a.test.ts\n");
  expect(run(root).code).not.toBe(0);
  writeFileSync(join(root, "manifest.txt"), "");
  writeFileSync(join(root, "durations.json"), JSON.stringify({ "test/a.test.ts": -1 }));
  expect(run(root).code).not.toBe(0);
});

test("the manifest check names unlisted darwin checks and stale entries", () => {
  // Split so this file does not itself look like a darwin check to the manifest scan.
  const gated = 'test.skipIf(process.platform !== ' + '"darwin")("x", () => {});';
  const root = fixture({}, "only test/gone.test.ts\n", { "test/gated.test.ts": gated, "test/plain.test.ts": "" });
  const result = run(root, {}, ["--check-macos-manifest"]);
  expect(result.code).not.toBe(0);
  expect(result.err).toContain("test/gated.test.ts: checks for darwin");
  expect(result.err).toContain("test/gone.test.ts: listed");
  expect(result.err).not.toContain("test/plain.test.ts");
  writeFileSync(join(root, "manifest.txt"), "mixed test/gated.test.ts\n");
  expect(run(root, {}, ["--check-macos-manifest"]).code).toBe(0);
});

test("the repository's macOS manifest covers every file that checks for darwin", () => {
  const result = Bun.spawnSync(["python3", script, "--check-macos-manifest"]);
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

test("timings add up each file's test results from the shard logs", () => {
  const root = fixture({});
  mkdirSync(join(root, "logs"));
  writeFileSync(join(root, "logs/shard0.log"), [
    "2026-11-18T03:00:01.0000000Z ##[group]test/a.test.ts:",
    "2026-11-18T03:00:01.5000000Z (pass) first [1.50s]",
    "2026-11-18T03:00:02.0000000Z (fail) second [500.00ms]",
    "2026-11-18T03:00:02.5000000Z ##[endgroup]",
    "2026-11-18T03:00:03.0000000Z (pass) outside any file [9.00s]",
    "2026-11-18T03:00:04.0000000Z ##[group]test/b.test.tsx:",
    "2026-11-18T03:00:04.2500000Z (pass) third [250.00ms]",
    "2026-11-18T03:00:04.5000000Z (skip) fourth",
  ].join("\n"));
  const output = join(root, "out.json");
  const extract = Bun.spawnSync(["python3", resolve("scripts/ci/extract-test-timings.py"), join(root, "logs"), output]);
  expect(extract.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({ "test/a.test.ts": 2, "test/b.test.tsx": 0.25 });
});

test("Linux shards run four test jobs and the macOS job keeps bun's default", () => {
  const root = fixture({ "test/a.test.ts": 1 }, "only test/a.test.ts\n");
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/bun"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const args = (...flags: string[]) => Bun.spawnSync(["python3", resolve("scripts/ci/run-tests.py"), ...flags], { cwd: root, env: { PATH: `${join(root, "bin")}:${process.env.PATH}`,
    SHARD_TIMINGS: join(root, "durations.json"), SHARD_MACOS_MANIFEST: join(root, "manifest.txt"), SHARD_INDEX: "0", SHARD_COUNT: "1" } }).stdout.toString().trim().split("\n");
  expect(args()).toEqual(["test", "--timeout", "30000", "--jobs=4", "./test/a.test.ts"]);
  expect(args("--macos")).toEqual(["test", "--timeout", "30000", "./test/a.test.ts"]);
});

const workflow = () => Bun.YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as any;

test("the shard matrix matches SHARD_COUNT and focused or docs-only runs use one shard", () => {
  const { test: job } = workflow().jobs;
  const matrix = job.strategy.matrix.shard as string;
  const shardList = JSON.parse(matrix.match(/'(\[[\d,]+\])' \|\|/)![1]!) as number[];
  const suite = job.steps.find((step: any) => step.name === "Test (full suite, sharded)");
  expect(shardList).toEqual(Array.from({ length: Number(suite.env.SHARD_COUNT) }, (_, index) => index));
  expect(suite.env.SHARD_EXCLUDE_MACOS).toBe("1");
  expect(matrix).toContain("|| '[0]'");
});

test("whole-tree checks run once outside the shards", () => {
  const { checks, test: job } = workflow().jobs;
  const commands = (steps: any[]) => steps.map(step => step.run);
  for (const command of ["bun run ui:check --source-only", "bun run typecheck", "bun run build", "./dist/pacer --version"]) {
    expect(commands(checks.steps)).toContain(command);
    expect(commands(job.steps)).not.toContain(command);
  }
});

test("the required gates fail unless every selected job passed", () => {
  const { "test-result": gate } = workflow().jobs;
  expect(gate.if).toBe("${{ !cancelled() }}");
  expect(gate.needs).toEqual(["changes", "checks", "test", "macos-tests", "rust"]);
  const script = gate.steps.at(-1).run as string;
  const check = (values: Record<string, string>) => Bun.spawnSync(["bash", "-e", "-c", script], { env: { PATH: process.env.PATH!,
    CHANGES_RESULT: "success", BUN_SELECTED: "true", FULL_SELECTED: "true", CHECKS_RESULT: "success", TEST_RESULT: "success", MACOS_RESULT: "success",
    RUST_SELECTED: "true", RUST_RESULT: "success", ...values } }).exitCode;
  expect(check({})).toBe(0);
  expect(check({ FULL_SELECTED: "false", MACOS_RESULT: "skipped" })).toBe(0);
  expect(check({ BUN_SELECTED: "false", CHECKS_RESULT: "skipped", MACOS_RESULT: "skipped" })).toBe(0);
  for (const failed of ["failure", "cancelled", "skipped"]) {
    expect(check({ CHANGES_RESULT: failed })).not.toBe(0);
    expect(check({ TEST_RESULT: failed })).not.toBe(0);
    expect(check({ CHECKS_RESULT: failed })).not.toBe(0);
    expect(check({ MACOS_RESULT: failed })).not.toBe(0);
    // A selected Rust job that didn't pass fails the required per-OS result.
    expect(check({ RUST_RESULT: failed })).not.toBe(0);
  }
  expect(check({ RUST_SELECTED: "false", RUST_RESULT: "skipped" })).toBe(0);
  expect(check({ RUST_SELECTED: "false", RUST_RESULT: "failure" })).not.toBe(0);
  expect(check({ FULL_SELECTED: "false", MACOS_RESULT: "failure" })).not.toBe(0);
});

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/errors";
import * as hosts from "../src/remote/hosts";
import { fakeCtx, tmpDir } from "./helpers";

const root = join(import.meta.dir, "..");

function decisionsLine(input: unknown) {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-lifecycle", "--example", "decisions", "--locked"], { cwd: root });
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root }).toString(),
  );
  const bin = join(metadata.target_directory, "debug/examples/decisions");
  return JSON.parse(execFileSync(bin, [], { input: JSON.stringify(input) + "\n", encoding: "utf8" }));
}

let nativeDriver: string;
function nativeResult(home: string, op: string, params: unknown, hostParts?: unknown) {
  if (!nativeDriver) {
    execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"], { cwd: root });
    const metadata = JSON.parse(
      execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root }).toString(),
    );
    nativeDriver = join(metadata.target_directory, "debug/examples/config_ops_diff");
  }
  const input = hostParts === undefined
    ? `{"op":${JSON.stringify(op)},"params":${JSON.stringify(params)},"home":${JSON.stringify(home)},"now":1700000000}\n`
    : `{"op":${JSON.stringify(op)},"params":${JSON.stringify(params)},"home":${JSON.stringify(home)},"now":1700000000,"hostParts":${JSON.stringify(hostParts)}}\n`;
  return JSON.parse(execFileSync(nativeDriver, [], { input }).toString());
}

function strategyHome(yaml: string) {
  const home = tmpDir();
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "strategy.yaml"), yaml, { mode: 0o600 });
  return home;
}

test("host.list summaries match Rust list helper", () => {
  const home = strategyHome(
    "planner: codex\nproviders: {codex: {}}\nhosts:\n  devbox: {ssh: devbox, max_tasks: 3}\n  pi: {ssh: pi.local, paused: true}\n",
  );
  const ctx = fakeCtx({ home, pacerHome: home, now: 1_700_000_000 });
  const ts = hosts.list(ctx);
  const rust = decisionsLine({
    op: "host.list",
    hosts: {
      devbox: { ssh: "devbox", maxTasks: 3, repos: {}, paused: false, session: "recording" },
      pi: { ssh: "pi.local", maxTasks: 2, repos: {}, paused: true, session: "recording" },
    },
    reachabilityByAlias: { devbox: { failures: 0 }, pi: { failures: 0 } },
    storedByAlias: { devbox: { checks: [] }, pi: { checks: [] } },
    jobs: [],
    runners: [],
    repos: [],
    tasks: [],
  });
  expect(rust).toEqual(ts);
});

test("native host.suggest matches TypeScript", async () => {
  const home = strategyHome("planner: codex\nproviders: {codex: {}}\nhosts:\n  devbox: {ssh: devbox}\n");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh/config"), "Host fresh-box\nHost devbox\n");
  const ctx = fakeCtx({ home, pacerHome: home, now: 1_700_000_000 });
  let expected: unknown;
  try {
    expected = { result: await callOp(ctx, "host.suggest", {}) };
  } catch (error) {
    expected = { error: toApiError(error) };
  }
  expect(nativeResult(home, "host.suggest", {})).toEqual(expected);

  try {
    expected = { result: await callOp(ctx, "host.suggest", { details: true }) };
  } catch (error) {
    expected = { error: toApiError(error) };
  }
  expect(nativeResult(home, "host.suggest", { details: true })).toEqual(expected);
});

test("native host.list matches TypeScript with injected snapshots", async () => {
  const home = strategyHome(
    "planner: codex\nproviders: {codex: {}}\nhosts:\n  devbox: {ssh: devbox, max_tasks: 3}\n",
  );
  const ctx = fakeCtx({ home, pacerHome: home, now: 1_700_000_000 });
  const { hostReadParts } = await import("../src/api/host-read-bridge");
  expect(nativeResult(home, "host.list", {}, hostReadParts(ctx))).toEqual({ result: hosts.list(ctx) });
});

test("native host.get matches TypeScript with injected snapshots", async () => {
  const home = strategyHome(
    "planner: claude-code\naccounts: {claude: {kind: claude}, codex: {kind: codex}}\nrouting: [{default: [codex@devbox, codex]}]\nhosts:\n  devbox: {ssh: devbox, repos: {\"github.com/o/r\": ~/src/r}, accounts: {codex: {home: ~/.codex}}}\n",
  );
  const ctx = fakeCtx({ home, pacerHome: home, now: 1_700_000_000 });
  const { hostReadDetailParts } = await import("../src/api/host-read-bridge");
  const parts = await hostReadDetailParts(ctx, "devbox");
  expect(nativeResult(home, "host.get", { alias: "devbox" }, parts)).toEqual({ result: await hosts.detail(ctx, "devbox") });
});

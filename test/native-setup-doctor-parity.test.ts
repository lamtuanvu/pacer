import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/errors";
import { setupDoctorBridge } from "../src/api/setup-doctor-bridge";
import type { Ctx } from "../src/types";
import { fakeCtx, tmpDir } from "./helpers";

const root = join(import.meta.dir, "..");
let driver: string | undefined;

function nativeResult(home: string, op: string, params: unknown, bridge: { echo: true } | { result: unknown }) {
  if (!driver) {
    execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"], { cwd: root });
    const metadata = JSON.parse(
      execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root }).toString(),
    );
    driver = join(metadata.target_directory, "debug/examples/config_ops_diff");
  }
  const input = { op, params, home, now: 1_700_000_000, ...("echo" in bridge ? { bridgeEcho: true } : { bridgeResult: bridge.result }) };
  return JSON.parse(execFileSync(driver, [], { input: `${JSON.stringify(input)}\n` }).toString());
}

function homeWithStrategy(): { home: string; ctx: Ctx } {
  const home = tmpDir();
  const ctx = fakeCtx({ home, pacerHome: home, now: 1_700_000_000, which: () => null });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "strategy.yaml"),
    "planner: claude-code\nproviders:\n  claude-code: {usage: quota}\nrouting:\n  - default: [claude-code]\n",
  );
  return { home, ctx };
}

async function expected(ctx: Ctx, op: string, params: unknown) {
  try { return { result: await callOp(ctx, op, params) }; }
  catch (error) { return { error: toApiError(error) }; }
}

function withoutDuration(value: unknown) {
  const { durationSeconds: _, steps, ...rest } = value as { durationSeconds?: number; steps?: unknown };
  return { ...rest, steps };
}

test("native setup.health and doctor.run reject invalid params like TypeScript", async () => {
  const { home, ctx } = homeWithStrategy();
  const cases: [string, unknown][] = [
    ["setup.health", { trigger: "nope" }],
    ["setup.health", { trigger: "Startup" }],
    ["setup.health", { trigger: 5 }],
    ["setup.health", { trigger: null }],
    ["setup.health", "s"],
    ["setup.health", 5],
    ["setup.health", []],
    ["doctor.run", 5],
    ["doctor.run", "s"],
    ["doctor.run", []],
  ];
  for (const [op, params] of cases) {
    const want = await expected(ctx, op, params);
    expect(want).toHaveProperty("error");
    expect(nativeResult(home, op, params, { result: "unused" })).toEqual(want);
  }
}, 120000);

test("native setup.health sends Core the parsed params and returns the bridge report", async () => {
  for (const params of [{}, null, { trigger: "startup" }, { trigger: "update", extra: 1 }, { trigger: "manual" }]) {
    const request = nativeResult(tmpDir(), "setup.health", params, { echo: true }).result;
    expect(request).toEqual({ op: "setup.health", params: params && "trigger" in params ? { trigger: params.trigger } : {} });

    const viaBridge = homeWithStrategy();
    const viaOp = homeWithStrategy();
    const bridged = await setupDoctorBridge(viaBridge.ctx, { ...request, snapshotProbe: false });
    const direct = await callOp(viaOp.ctx, "setup.health", params, { snapshotProbe: false });
    expect(withoutDuration(bridged)).toEqual(withoutDuration(direct));
    expect(nativeResult(viaBridge.home, "setup.health", params, { result: bridged })).toEqual({ result: bridged });
  }
}, 120000);

test("native doctor.run sends Core empty params and returns the bridge report", async () => {
  for (const params of [{}, null, { extra: true }]) {
    const request = nativeResult(tmpDir(), "doctor.run", params, { echo: true }).result;
    expect(request).toEqual({ op: "doctor.run", params: {} });

    const { home, ctx } = homeWithStrategy();
    const bridged = await setupDoctorBridge(ctx, request) as { checks: { name: string; level: string }[] };
    const direct = await callOp(ctx, "doctor.run", params) as typeof bridged;
    expect(bridged.checks.map(check => [check.name, check.level])).toEqual(direct.checks.map(check => [check.name, check.level]));
    expect(nativeResult(home, "doctor.run", params, { result: bridged })).toEqual({ result: bridged });
  }
}, 120000);

test("setup doctor bridge refuses other operations", async () => {
  const { ctx } = homeWithStrategy();
  for (const body of [null, [], {}, { op: "setup.check" }, { op: "service.install", params: { consent: true } }]) {
    await expect(setupDoctorBridge(ctx, body)).rejects.toMatchObject({ code: "invalid_input" });
  }
});

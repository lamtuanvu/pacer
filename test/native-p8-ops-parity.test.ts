import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/errors";
import { onboardingSkip } from "../src/core/setup";
import { checkSetup } from "../src/setup/check";
import { fakeCtx, tmpDir } from "./helpers";
import { setIdentityPlatformForTests, clearIdentityCache } from "../src/identity/store";

const root = join(import.meta.dir, "..");

function nativeResult(home: string, op: string, params: unknown, bridgeResult?: unknown) {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-server", "--example", "config_ops_diff", "--locked"], { cwd: root });
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root }).toString(),
  );
  const driver = join(metadata.target_directory, "debug/examples/config_ops_diff");
  const input = bridgeResult === undefined
    ? `{"op":${JSON.stringify(op)},"params":${JSON.stringify(params)},"home":${JSON.stringify(home)},"now":1700000000}\n`
    : `{"op":${JSON.stringify(op)},"params":${JSON.stringify(params)},"home":${JSON.stringify(home)},"now":1700000000,"bridgeResult":${JSON.stringify(bridgeResult)}}\n`;
  return JSON.parse(execFileSync(driver, [], { input }).toString());
}

test("native onboarding.skip matches TypeScript", () => {
  const home = tmpDir();
  const ctx = fakeCtx({ home, pacerHome: home, now: 1_700_000_000 });
  expect(onboardingSkip(ctx)).toEqual({ skipped: true });
  expect(existsSync(join(home, "onboarding", "skipped"))).toBe(true);
  expect(nativeResult(home, "onboarding.skip", {})).toEqual({ result: { skipped: true } });
});

test("native machine.get matches TypeScript with injected bridge", async () => {
  setIdentityPlatformForTests("linux");
  const home = tmpDir();
  const ctx = fakeCtx({ home, pacerHome: home, now: 1_700_000_000 });
  clearIdentityCache();
  let expected: unknown;
  try {
    expected = { result: await callOp(ctx, "machine.get", {}) };
  } catch (error) {
    expected = { error: toApiError(error) };
  }
  const bridgeResult = "error" in (expected as any) ? undefined : (expected as any).result;
  if (bridgeResult) {
    expect(nativeResult(home, "machine.get", {}, bridgeResult)).toEqual(expected);
  }
});

test("native setup.check matches TypeScript with injected bridge", async () => {
  const home = tmpDir();
  const ctx = fakeCtx({ home, pacerHome: home, now: 1_700_000_000, which: () => null, env: { PACER_BIN: "pacer" } });
  const checklist = await checkSetup(ctx, { snapshotProbe: false, deferStatus: true });
  expect(nativeResult(home, "setup.check", {}, checklist)).toEqual({ result: checklist });
});

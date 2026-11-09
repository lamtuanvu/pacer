import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { COMMANDS as PLAN3 } from "../src/commands/plan3";
import { setupCmd } from "../src/commands/setup";
import { callOp } from "../src/api/ops";
import * as config from "../src/core/config";

const installCmd = PLAN3.find((c) => c.name === "install")!;
const uninstallCmd = PLAN3.find((c) => c.name === "uninstall")!;

function executorCtx() {
  return fakeCtx({ env: { PACER_ROLE: "executor" } });
}

test("N5: pacer install and pacer uninstall refuse an executor session", async () => {
  const ctx = executorCtx();
  const installed = await installCmd.run(["codex"], ctx);
  expect(installed.code).toBe(2);
  expect(installed.err).toMatch(/executor/);
  const removed = await uninstallCmd.run(["codex"], ctx);
  expect(removed.code).toBe(2);
  expect(removed.err).toMatch(/executor/);
});

test("N5: a config.set planner change refuses an executor session", async () => {
  const ctx = executorCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\npacing: {policy: priority}\nrouting: [{default: [codex]}]\n");
  await expect(callOp(ctx, "config.set", { key: "planner", value: "codex", integrations: "install" }))
    .rejects.toMatchObject({ code: "not_allowed", message: expect.stringContaining("executor") });
  await expect(config.set(ctx, "planner", "codex", { integrations: "install" }))
    .rejects.toMatchObject({ code: "not_allowed", message: expect.stringContaining("executor") });
});

test("N5: pacer setup refuses an executor session (L1)", async () => {
  const refused = await setupCmd([], executorCtx());
  expect(refused.code).toBe(2);
  expect(refused.err).toMatch(/executor/);
  // A non-executor proceeds past the executor gate (a happy path check, e.g. into arg handling).
  const non = await setupCmd(["--planner", "not-an-agent"], fakeCtx());
  expect(non.code).toBe(2);
  expect(non.err).toMatch(/unknown planner/);
});

test("N5: a non-executor can still install and change the planner", async () => {
  const ctx = fakeCtx();
  const bad = await installCmd.run(["not-an-agent"], ctx);
  // Reaches the argument check (install target validation) because the caller is not an executor.
  expect(bad.code).toBe(2);
  expect(bad.err).toMatch(/unknown planner/);
});
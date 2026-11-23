import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installFixture } from "../conformance/install";
import { fakeCtx } from "./helpers";
import { PluginRegistry } from "../src/plugins/registry";
import { EXTENSION_METHODS, manifestSchema } from "../src/plugins/protocol";

test("Orca executor contribution and session state have a bounded, credential-free contract", () => {
  const manifest = { id: "fx-orca", version: "1.0.0", publisher: "fixture", host: "^1.5",
    contributes: { executor: { backends: ["orca"] } }, capabilities: [] };
  expect(manifestSchema.safeParse(manifest).success).toBe(true);
  expect(manifestSchema.safeParse({ ...manifest, contributes: { executor: { backends: ["orca", "direct"] } } }).success).toBe(false);
  const method = EXTENSION_METHODS["executor.sessionState"];
  expect(method.deadlineMs).toBe(10_000);
  expect(method.params.safeParse({ taskId: "task-123" }).success).toBe(true);
  for (const input of [{ taskId: "" }, { taskId: "task-123", handle: "terminal-1" },
    { taskId: "task-123", env: { TOKEN: "secret" } }, { taskId: "x".repeat(129) }])
    expect(method.params.safeParse(input).success).toBe(false);
  expect(method.result.safeParse({ live: true, handle: "terminal-1" }).success).toBe(true);
  expect(method.result.safeParse({ live: false }).success).toBe(true);
  for (const result of [{ live: true, handle: "" }, { live: true, host: "orca" },
    { live: false, handle: "terminal-1", credentials: "secret" }])
    expect(method.result.safeParse(result).success).toBe(false);
});

test("fake Orca executor serves session state without starting a worker", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-orca-contract-"));
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer"),
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, now: Date.now() / 1000 });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\n");
  const folder = installFixture("executor", join(ctx.pacerHome, "plugins"));
  writeFileSync(join(folder, "pacer-plugin.json"), JSON.stringify({ id: "fx-executor", version: "1.0.0",
    publisher: "pacer-conformance", host: "^1.5", entry: "main.ts",
    contributes: { executor: { backends: ["orca"] } }, capabilities: [] }));
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundle"); }, eventPumpMs: 0 });
  try {
    await registry.enable(ctx, "fx-executor", true);
    expect(registry.list(ctx)[0]?.pid).toBeNull();
    const state = await registry.call(ctx, "fx-executor", "executor.sessionState", { taskId: "task-123" });
    expect(state).toEqual({ live: false });
    await expect(registry.call(ctx, "fx-executor", "executor.sessionState", { taskId: "task-123", handle: "stolen" }))
      .rejects.toMatchObject({ code: "invalid_input" });
  } finally { await registry.shutdown(); rmSync(home, { recursive: true, force: true }); }
});

import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installFixture } from "../conformance/install";
import { fakeCtx } from "./helpers";
import { PluginRegistry } from "../src/plugins/registry";
import type { PluginProcess } from "../src/plugins/process";
import { manifestSchema } from "../src/plugins/protocol";

test("host broker forwards a fixed script through one selected provider and retires caller sessions", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-host-broker-"));
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(home, "node_modules"), "dir");
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer"), env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    which: name => name === "ssh" ? process.execPath : null, now: Date.now() / 1000 });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n");
  const providerFolder = installFixture("host-runner", join(ctx.pacerHome, "plugins"));
  const manifest = manifestSchema.parse({ id: "host-broker-caller", version: "1.0.0", publisher: "pacer", host: "^1.7",
    contributes: {}, capabilities: [{ name: "hosts" }], reentrant: true });
  const registry = new PluginRegistry({ bundled: [{ manifest, main: async () => ({ handlers: {} }) }],
    spawnBundled: () => ({ argv: [process.execPath, join(import.meta.dir, "fixtures", "host-broker", "caller.ts")], cwd: home, env: {} }), eventPumpMs: 0 });
  try {
    await registry.enable(ctx, "fx-host-runner", true);
    const result = await registry.call<{ output: string; session: string }>(ctx, "host-broker-caller", "diagnostic.ping", {});
    expect(result.output).toBe("");
    expect(result.session).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    await expect(registry.call(ctx, "host-broker-caller", "diagnostic.ping", { session: result.session }))
      .rejects.toMatchObject({ code: "capability_denied" });
    await expect(registry.call(ctx, "host-broker-caller", "diagnostic.ping", { alias: "absent" }))
      .rejects.toMatchObject({ code: "not_found" });
    const provider = (registry as unknown as { entries: Map<string, { process?: PluginProcess }> })
      .entries.get("fx-host-runner")!.process!;
    await registry.disable(ctx, "fx-host-runner");
    await registry.enable(ctx, "fx-host-runner", true);
    await expect(registry.call(ctx, "fx-host-runner", "hostRunner.open",
      { alias: "box", sshTarget: "ssh-fixture" }, { deadlineMs: 1000, expectedProcess: provider }))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(registry.list(ctx).find(plugin => plugin.id === "fx-host-runner")?.pid).toBeNull();
    writeFileSync(join(providerFolder, "fixture.json"), JSON.stringify({ delayMs: 3000, delayMethod: "hostRunner.run" }));
    const receipt = join(home, "broker-receipt.jsonl");
    const before = readFileSync(receipt, "utf8");
    const running = registry.call(ctx, "host-broker-caller", "diagnostic.ping", {});
    const log = join(providerFolder, "calls.jsonl"), until = Date.now() + 2000;
    while ((!existsSync(log) || !readFileSync(log, "utf8").includes('"phase":"enter"')) && Date.now() < until) await Bun.sleep(10);
    expect(readFileSync(log, "utf8")).toContain('"method":"hostRunner.run"');
    const strategyPath = join(ctx.pacerHome, "strategy.yaml");
    writeFileSync(strategyPath, readFileSync(strategyPath, "utf8").replace("ssh: ssh-fixture", "ssh: ssh-changed"));
    await expect(running).rejects.toBeDefined();
    const cancelledUntil = Date.now() + 1000;
    while (!readFileSync(log, "utf8").includes('"phase":"cancelled"') && Date.now() < cancelledUntil) await Bun.sleep(10);
    expect(readFileSync(log, "utf8")).toContain('"phase":"cancelled"');
    expect(readFileSync(receipt, "utf8")).toBe(before);
  } finally {
    await registry.shutdown();
    rmSync(home, { recursive: true, force: true });
  }
});

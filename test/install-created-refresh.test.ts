import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { PACER } from "./install-helpers";
import { installPlanner } from "../src/install";
import { reconcileIntegrations } from "../src/install/reconcile";
import { uninstallPlanner } from "../src/install/uninstall";
import { readManifest, writeManifest } from "../src/install/manifest";
import { sha256 } from "../src/install/fsx";

for (const named of [false, true]) {
  test(`${named ? "named" : "default"} created hooks retain user additions after refresh and uninstall`, async () => {
    const ctx = fakeCtx({ env: { PACER_BIN: PACER[0] } });
    const folder = named ? join(ctx.home, "accounts/work") : join(ctx.home, ".codex");
    const key = named ? "codex#work" : "codex";
    const target = named ? { agent: "codex" as const, account: "work" } : "codex" as const;
    if (named) {
      mkdirSync(ctx.pacerHome, { recursive: true });
      writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({ planner: "codex#work", accounts: { work: { kind: "codex", home: folder, usage: "quota" } }, runners: { "codex#work": {} }, routing: [{ default: ["codex#work"] }] }));
    }
    await installPlanner({ ctx, pacerArgv: PACER }, target);
    const path = join(folder, "hooks.json"), settings = JSON.parse(readFileSync(path, "utf8"));
    const user = { hooks: [{ type: "command", command: "user-hook --keep", timeout: 17 }] };
    settings.hooks.SessionStart.push(user);
    writeFileSync(path, JSON.stringify(settings));
    ctx.env.PACER_BIN = "/opt/new/pacer";
    expect((await reconcileIntegrations(ctx, { target: key }))[0].state).toBe("refreshed");
    const recorded = readManifest(ctx).planners[key].files.find(file => file.path === path)!;
    expect(recorded).toMatchObject({ action: "created", exact: false });
    expect(recorded.afterHash).toBe(sha256(readFileSync(path, "utf8")));
    const report = await uninstallPlanner(ctx, target);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).hooks.SessionStart).toEqual([user]);
    expect(readFileSync(path, "utf8")).not.toContain("/opt/new/pacer");
    expect(report?.reverted).toContain(path);
    expect(report?.removed).not.toContain(path);
    expect(readManifest(ctx).planners[key]).toBeUndefined();
  });
}

for (const legacy of [false, true]) {
  test(`untouched created file still removes on uninstall (legacy=${legacy})`, async () => {
    const ctx = fakeCtx();
    await installPlanner({ ctx, pacerArgv: PACER }, "codex");
    const path = join(ctx.home, ".codex/hooks.json");
    if (legacy) {
      const manifest = readManifest(ctx);
      delete manifest.planners.codex.files.find(file => file.path === path)!.exact;
      writeManifest(ctx, manifest);
    }
    expect((await uninstallPlanner(ctx, "codex"))?.removed).toContain(path);
    expect(existsSync(path)).toBe(false);
  });
}

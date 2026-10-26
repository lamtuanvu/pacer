import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./install-plugin-fixtures";
import { installPlanner } from "../src/install";
import { readManifest } from "../src/install/manifest";
import { reconcileIntegrations } from "../src/install/reconcile";
import { uninstallPlanner } from "../src/install/uninstall";
import { cleanupRecordedPlanner } from "../src/install/recorded-cleanup";
import { preparePlannerUninstallFiles } from "../packages/plugin-sdk/src/install/uninstall";
import { sha256 } from "../packages/plugin-sdk/src/install/helpers";
import type { PlannerRecord } from "../packages/plugin-sdk/src/install/undo";

for (const cleanup of ["target", "recorded"] as const)
  test(`${cleanup} uninstall preserves user settings in a created file after reconciliation`, async () => {
    const ctx = fakeCtx({ which: () => null });
    const folder = join(ctx.home, ".codex"), hooks = join(folder, "hooks.json");
    await installPlanner({ ctx, pacerArgv: ["/opt/pacer/bin/pacer"] }, "codex");
    const doc = JSON.parse(readFileSync(hooks, "utf8"));
    doc.theme = "user-dark";
    writeFileSync(hooks, JSON.stringify(doc));
    expect((await reconcileIntegrations(ctx, { target: "codex" }))[0].state).toBe("refreshed");
    const record = readManifest(ctx).planners.codex.files.find(file => file.path === hooks)!;
    expect(record.exact).toBe(false);
    expect(record.afterHash).toBe(sha256(readFileSync(hooks, "utf8")));
    if (cleanup === "target") await uninstallPlanner(ctx, "codex");
    else await cleanupRecordedPlanner(ctx, "codex");
    const restored = JSON.parse(readFileSync(hooks, "utf8"));
    expect(restored.theme).toBe("user-dark");
    expect(JSON.stringify(restored.hooks ?? {})).not.toContain("/opt/pacer/bin/pacer");
    expect(existsSync(join(folder, "skills/pacer/SKILL.md"))).toBe(false);
    expect(readManifest(ctx).planners.codex).toBeUndefined();
  });

for (const exact of [true, false, undefined])
  test(`unchanged wholly created file is removed with exact=${exact}`, async () => {
    const path = "/fixture/owned.txt", text = "owned bytes";
    const record: PlannerRecord = { planner: "codex", installedAt: 1, pacerArgv: ["pacer"], commands: [], notes: [],
      files: [{ path, action: "created", afterHash: sha256(text), ...(exact === undefined ? {} : { exact }), undo: [] }] };
    const plan = await preparePlannerUninstallFiles({ read: async () => ({ text, mode: 0o600 }) }, record);
    expect(plan.files).toEqual([{ path, before: text, after: null, beforeMode: 0o600 }]);
    expect(plan.uninstallReport.removed).toEqual([path]);
  });

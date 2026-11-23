import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addApp, listApps, openApp, removeApp, updateApp } from "../src/apps";
import { grantsFromOrcaApproval, grantWords } from "../src/apps/grants";
import { ORCA_PANEL_DIR_ENV, ORCA_PANEL_OLD_PLUGIN_ID, ORCA_PANEL_PLUGIN_KEY } from "../src/plugin/orca-panel-cli";
import type { Ctx, RunFn, RunResult } from "../src/types";
import { fakeCtx } from "./helpers";

const ok = (stdout = '{"ok":true,"result":{}}'): RunResult => ({ code: 0, stdout, stderr: "" });

function fixturePanelDir(version = "0.1.0"): string {
  const dir = mkdtempSync(join(tmpdir(), "pacer-orca-panel-"));
  writeFileSync(join(dir, "orca-plugin.json"), JSON.stringify({ id: "pacer", version, name: "Pacer" }));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "panel.html"), "<html></html>");
  return dir;
}

function ctxWith(run: RunFn, which: Ctx["which"] = () => "/usr/bin/orca", panelDir?: string): Ctx {
  const dir = panelDir ?? fixturePanelDir();
  return fakeCtx({
    run,
    which,
    env: { [ORCA_PANEL_DIR_ENV]: dir, PACER_BIN: join(dir, "pacer-bin") },
  });
}

const approval = (fp = "ap1-x", stale = false) =>
  ok(
    JSON.stringify({
      ok: false,
      error: {
        code: stale ? "approval_stale" : "approval_required",
        message: "needs approval",
        data: {
          approvalFingerprint: fp,
          grants: {
            execution: "trusted-worker",
            executionDescription: "Runs its own code",
            capabilities: [
              { kind: "storage:own", description: "Store data" },
              { kind: "workspace:read", description: "Read workspaces" },
              { kind: "workspace:write", description: "Write workspaces" },
            ],
          },
        },
      },
    }),
  );

const statusReady = ok(
  JSON.stringify({
    ok: true,
    result: { app: { running: true }, runtime: { appVersion: "1.4.262", reachable: true } },
  }),
);

const listPlugins = (plugins: object[]) =>
  ok(JSON.stringify({ ok: true, result: { plugins } }));

test("grantWords maps known kinds and keeps unknown descriptions", () => {
  expect(grantWords("storage:own").what).toContain("storage");
  const unknown = grantWords("future:kind", "Orca said this");
  expect(unknown.what).toBe("Orca said this");
  expect(unknown.why).toBe("Orca said this");
});

test("grantsFromOrcaApproval flattens execution then capabilities", () => {
  const grants = grantsFromOrcaApproval({
    execution: "trusted-worker",
    executionDescription: "Runs code",
    capabilities: [{ kind: "storage:own", description: "Store" }],
  });
  expect(grants.map((g) => g.kind)).toEqual(["trusted-worker", "storage:own"]);
});

test("listApps: not found when orca is missing", async () => {
  const { apps } = await listApps(ctxWith(async () => ok(), () => null));
  expect(apps).toHaveLength(1);
  expect(apps[0]!.presence.kind).toBe("not_found");
});

test("listApps: missing_files when panel dir is absent", async () => {
  const ctx = fakeCtx({
    run: async () => ok(),
    which: () => "/usr/bin/orca",
    env: { [ORCA_PANEL_DIR_ENV]: "/no/such/orca-panel" },
  });
  const { apps } = await listApps(ctx);
  expect(apps[0]!.presence).toEqual({
    kind: "missing_files",
    reason: "This pacer install doesn't include the Orca panel",
  });
});

test("listApps: ready when Orca is present and panel is not installed", async () => {
  const run: RunFn = async (argv) => {
    if (argv.includes("status")) return statusReady;
    if (argv.includes("list")) return listPlugins([]);
    return ok();
  };
  const { apps } = await listApps(ctxWith(run));
  expect(apps[0]!.presence.kind).toBe("ready");
  if (apps[0]!.presence.kind === "ready") {
    expect(apps[0]!.presence.hostVersion).toContain("1.4.262");
  }
});

test("listApps: added, update available, and old plugin flag", async () => {
  const dir = fixturePanelDir("0.2.0");
  const run: RunFn = async (argv) => {
    if (argv.includes("status")) return statusReady;
    if (argv.includes("list")) {
      return listPlugins([
        { pluginKey: ORCA_PANEL_PLUGIN_KEY, status: "running", version: "0.1.0" },
        { pluginKey: ORCA_PANEL_OLD_PLUGIN_ID, status: "running", version: "0.0.1" },
      ]);
    }
    return ok();
  };
  const { apps } = await listApps(ctxWith(run, () => "/usr/bin/orca", dir));
  expect(apps[0]!.oldPlugin).toBe(true);
  expect(apps[0]!.presence).toMatchObject({
    kind: "added",
    installedVersion: "0.1.0",
    bundledVersion: "0.2.0",
    updateAvailable: true,
  });
});

test("addApp returns approval_required with grants; approve finishes; stale returns new fingerprint", async () => {
  const calls: string[][] = [];
  let mode: "need" | "stale" | "ok" = "need";
  const run: RunFn = async (argv) => {
    calls.push(argv);
    if (argv.includes("install")) {
      if (mode === "need") return approval("ap1-old");
      if (mode === "stale") return approval("ap1-new", true);
      return ok();
    }
    return ok();
  };
  const ctx = ctxWith(run);

  const need = await addApp(ctx, "orca");
  expect(need).toMatchObject({ status: "approval_required", fingerprint: "ap1-old" });
  if (need.status === "approval_required") expect(need.grants.length).toBeGreaterThan(0);

  mode = "ok";
  expect(await addApp(ctx, "orca", "ap1-old")).toEqual({ status: "added", id: "orca" });
  expect(calls.some((a) => a.includes("--approve") && a.includes("ap1-old"))).toBe(true);

  mode = "stale";
  const stale = await addApp(ctx, "orca", "ap1-old");
  expect(stale).toMatchObject({ status: "approval_required", fingerprint: "ap1-new", stale: true });
});

test("open/update/remove and unknown id", async () => {
  const calls: string[][] = [];
  const run: RunFn = async (argv) => {
    calls.push(argv);
    return ok();
  };
  const ctx = ctxWith(run);
  expect(await openApp(ctx, "orca")).toEqual({ ok: true, id: "orca" });
  expect(calls.some((a) => a.includes("open") && a.includes("--panel") && a.includes("pacer"))).toBe(true);
  expect(await updateApp(ctx, "orca")).toEqual({ status: "added", id: "orca" });
  expect(await removeApp(ctx, "orca")).toEqual({ ok: true, id: "orca" });
  await expect(addApp(ctx, "nope")).rejects.toMatchObject({ code: "not_found" });
});

import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp, opJsonSchemas, opNames } from "../src/api/ops";
import { V3_ONLY_OPS } from "../src/api/v2-compat";
import { ORCA_PANEL_DIR_ENV } from "../src/plugin/orca-panel-cli";
import type { RunResult } from "../src/types";
import { fakeCtx } from "./helpers";

const ok = (stdout = '{"ok":true,"result":{}}'): RunResult => ({ code: 0, stdout, stderr: "" });

function panelDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pacer-apps-ops-"));
  writeFileSync(join(dir, "orca-plugin.json"), JSON.stringify({ id: "pacer", version: "0.1.0" }));
  mkdirSync(join(dir, "src"));
  return dir;
}

test("apps.* ops are registered, v3-only, and schema-described", () => {
  for (const name of ["apps.list", "apps.add", "apps.open", "apps.update", "apps.remove"] as const) {
    expect(opNames()).toContain(name);
    expect(V3_ONLY_OPS.has(name)).toBe(true);
    expect(opJsonSchemas()[name]?.description.length).toBeGreaterThan(10);
    expect(opJsonSchemas()[name]?.params).toBeTruthy();
  }
});

test("apps.list and apps.add call through with injected run", async () => {
  const dir = panelDir();
  const ctx = fakeCtx({
    which: () => null,
    env: { [ORCA_PANEL_DIR_ENV]: dir },
    run: async () => ok(),
  });
  const listed = (await callOp(ctx, "apps.list", {})) as { apps: { id: string; presence: { kind: string } }[] };
  expect(listed.apps[0]?.id).toBe("orca");
  expect(listed.apps[0]?.presence.kind).toBe("not_found");

  const ready = fakeCtx({
    which: () => "/usr/bin/orca",
    env: { [ORCA_PANEL_DIR_ENV]: dir },
    run: async (argv) => {
      if (argv.includes("status")) {
        return ok(JSON.stringify({ ok: true, result: { app: { running: true }, runtime: { appVersion: "1.0.0", reachable: true } } }));
      }
      if (argv.includes("list")) return ok(JSON.stringify({ ok: true, result: { plugins: [] } }));
      if (argv.includes("install")) {
        return {
          code: 3,
          stdout: "",
          stderr: JSON.stringify({
            error: {
              code: "approval_required",
              message: "approve",
              data: { approvalFingerprint: "ap1-z", grants: { execution: "trusted-worker", capabilities: [] } },
            },
          }),
        };
      }
      return ok();
    },
  });
  const add = (await callOp(ready, "apps.add", { id: "orca" })) as { status: string; fingerprint?: string };
  expect(add).toMatchObject({ status: "approval_required", fingerprint: "ap1-z" });
});

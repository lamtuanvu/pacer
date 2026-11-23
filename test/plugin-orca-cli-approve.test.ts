import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { ORCA_PANEL_DIR_ENV } from "../src/plugin/orca-panel-cli";
import type { RunResult } from "../src/types";
import { fakeCtx } from "./helpers";

const ok = (stdout = '{"ok":true,"result":{}}'): RunResult => ({ code: 0, stdout, stderr: "" });

function panelDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pacer-plugin-cli-"));
  writeFileSync(join(dir, "orca-plugin.json"), JSON.stringify({ id: "pacer", version: "0.1.0" }));
  mkdirSync(join(dir, "src"));
  return dir;
}

test("pacer plugin install prints grants and the exact --approve retry", async () => {
  const dir = panelDir();
  const ctx = fakeCtx({
    env: { [ORCA_PANEL_DIR_ENV]: dir },
    run: async () => ({
      code: 3,
      stdout: "",
      stderr: JSON.stringify({
        error: {
          code: "approval_required",
          message: "needs approval",
          data: {
            approvalFingerprint: "ap1-abc",
            grants: {
              execution: "trusted-worker",
              capabilities: [{ kind: "storage:own", description: "Store" }],
            },
          },
        },
      }),
    }),
  });
  const r = await main(["plugin", "install"], ctx);
  expect(r.code).toBe(3);
  expect(r.err).toContain("Orca will let pacer:");
  expect(r.err).toContain("pacer plugin install --approve ap1-abc");
});

test("pacer plugin install --approve <fp> retries with that fingerprint", async () => {
  const dir = panelDir();
  const calls: string[][] = [];
  const ctx = fakeCtx({
    env: { [ORCA_PANEL_DIR_ENV]: dir },
    run: async (argv) => {
      calls.push(argv);
      return ok();
    },
  });
  const r = await main(["plugin", "install", "--approve", "ap1-abc"], ctx);
  expect(r.code).toBe(0);
  expect(calls[0]).toEqual(["orca", "plugin", "install", dir, "--approve", "ap1-abc", "--json"]);
});

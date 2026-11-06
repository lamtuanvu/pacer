import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createTask, readTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

const ROOT = join(import.meta.dir, "..");
const TARGET = join(ROOT, "target");

function rustDismiss(pacerHome: string, ids: string[], expectRev: number | null, now: number) {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-lifecycle", "--bin", "dismiss_probe"], {
    cwd: ROOT,
    env: { ...process.env, CARGO_TARGET_DIR: TARGET },
  });
  const probe = join(TARGET, "debug", "dismiss_probe");
  const out = execFileSync(
    probe,
    [pacerHome, JSON.stringify(ids), expectRev === null ? "" : String(expectRev), String(now)],
    { encoding: "utf8" },
  );
  return JSON.parse(out) as { dismissed: string[]; unknown: string[] };
}

test("dismiss_tasks matches taskDismiss store fields", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, {
    brief: { goal: "Dismiss me", repo: ctx.home },
    kind: null,
    requestedExecutor: null,
    timeoutS: 60,
  });
  const batch = rustDismiss(ctx.pacerHome, ["missing-1", t.id, "missing-2"], null, ctx.now);
  expect(batch.dismissed).toEqual([t.id]);
  expect(batch.unknown).toEqual(["missing-1", "missing-2"]);
  expect(readTask(ctx, t.id)?.dismissed).toBe(true);
});

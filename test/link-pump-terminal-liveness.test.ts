import { expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { pumpOnce, defaultPumpDeps } from "../src/link/pump";
import { createTerminal } from "../src/terminal/workspace";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

test("a quiet poll runs the terminal liveness check after ~2s and skips it before", async () => {
  const ctx = fakeCtx({ which: () => null, env: { ...process.env } });
  const terminal = await createTerminal(ctx, { requestId: "pump-term", kind: "shell", cwd: ctx.home }, { start: () => ({ pid: 99999999 }) });
  // Establish the first pass and its terminal baseline.
  await pumpOnce(ctx, defaultPumpDeps, { poll: true });
  // A change that the next eligible check should publish.
  writeFileSync(join(ctx.pacerHome, "terminals", terminal.id, "exit"), "7");
  // Before ~2s the terminal check is skipped.
  const before = await pumpOnce({ ...ctx, now: ctx.now + 0.5 }, defaultPumpDeps, { poll: true });
  expect(before.filter(e => e.type === "entity" && (e.data as any)?.kind === "terminal")).toHaveLength(0);
  // After ~2s the check runs and publishes the change.
  await Bun.sleep(2100);
  const after = await pumpOnce({ ...ctx, now: ctx.now + 2 }, defaultPumpDeps, { poll: true });
  expect(after.some(e => e.type === "entity" && (e.data as any)?.kind === "terminal")).toBe(true);
});
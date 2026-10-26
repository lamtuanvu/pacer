import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { fakeCtx } from "./helpers";
import { goldenPath, recordStrategyRemove } from "../scripts/golden/strategy-remove";

test("strategy.remove TypeScript state, event and refusal goldens remain fresh", async () => {
  expect(await recordStrategyRemove()).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")));
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "pacer-remove-case-"));
  const pacerHome = join(home, ".pacer");
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"))[0];
  mkdirSync(join(pacerHome, "strategies"), { recursive: true });
  writeFileSync(join(pacerHome, "strategy.yaml"), golden.defaultYaml);
  writeFileSync(join(pacerHome, "strategies/research.yaml"), golden.researchYaml);
  return { home, pacerHome, ctx: fakeCtx({ home, pacerHome, now: 1_700_000_000 }) };
}

test("strategy.remove leaves a deleted file deleted when activity append fails", async () => {
  const { home, pacerHome, ctx } = fixture();
  try {
    mkdirSync(join(pacerHome, "state/activity.jsonl"), { recursive: true });
    await expect(callOp(ctx, "strategy.remove", { name: "research" })).rejects.toThrow(/EISDIR/);
    expect(existsSync(join(pacerHome, "strategies/research.yaml"))).toBe(false);
    expect(existsSync(join(pacerHome, "link/outbox.jsonl"))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("strategy.remove rechecks active selection after waiting for the shared lock", async () => {
  const { home, pacerHome, ctx } = fixture();
  try {
    mkdirSync(join(pacerHome, "orca"), { recursive: true });
    const lock = join(pacerHome, "orca/strategy.lock");
    writeFileSync(lock, "held");
    const pending = callOp(ctx, "strategy.remove", { name: "research" });
    try { await Bun.sleep(75); writeFileSync(join(pacerHome, "active"), "research\n"); }
    finally { rmSync(lock, { force: true }); }
    await expect(pending).rejects.toMatchObject({ code: "not_allowed", message: "cannot delete the active strategy" });
    expect(existsSync(join(pacerHome, "strategies/research.yaml"))).toBe(true);
    expect(existsSync(join(pacerHome, "link/outbox.jsonl"))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("strategy.remove ignores a symlinked named file", async () => {
  const { home, pacerHome, ctx } = fixture();
  try {
    const target = join(home, "outside.yaml");
    writeFileSync(target, "untouched");
    rmSync(join(pacerHome, "strategies/research.yaml"));
    symlinkSync(target, join(pacerHome, "strategies/research.yaml"));
    await expect(callOp(ctx, "strategy.remove", { name: "research" })).rejects.toMatchObject({ code: "invalid_input", message: 'unknown strategy "research"' });
    expect(readFileSync(target, "utf8")).toBe("untouched");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
